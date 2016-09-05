import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import { MemoryDataStore, RtmClient, WebClient } from '@slack/client';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';
import { highlightUsername } from './helpers';

const ALLOWED_SUBTYPES = ['me_message'];
const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    const web = new WebClient(options.token);
    const rtm = new RtmClient(options.token, { dataStore: new MemoryDataStore() });
    this.slack = { web, rtm };

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.commandCharacters = options.commandCharacters || [];
    this.channels = _.values(options.channelMapping);
    this.muteSlackbot = options.muteSlackbot || false;

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      autoConnect: false,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...options.ircOptions
    };
    this.ircOptions = ircOptions;
    this.ircClients = {};

    const defaultUrl = 'http://api.adorable.io/avatars/48/$username.png';
    // Disable if it's set to false, override default with custom if available:
    this.avatarUrl = options.avatarUrl !== false && (options.avatarUrl || defaultUrl);
    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, slackChan) => {
      this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
    }, this);

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Slack');
    this.slack.rtm.start();

    this.ircClient = new irc.Client(this.server, this.nickname, this.ircOptions);
    this.ircClient.connect(5, msg => {
      if (msg.rawCommand === '001') {
        logger.debug('IRC bot connected.');
      } else {
        throw new Error('IRC bot could not connect.');
      }
    });
    this.attachListeners();
  }

  attachListeners() {
    this.slack.rtm.on('open', () => {
      logger.debug('Connected to Slack');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
    });

    this.ircClient.on('abort', () => {
      logger.error('Maximum IRC retry count reached, exiting.');
      process.exit(1);
    });

    this.slack.rtm.on('error', error => {
      logger.error('Received error event from Slack', error);
    });

    this.slack.rtm.on('message', message => {
      // Ignore bot messages and people leaving/joining
      if (message.type === 'message' &&
        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)) {
        this.sendToIRC(message);
      }
    });

    this.slack.rtm.on('presence_change', event => {
      // Connect/disconnect based on 'active'/'away' Slack status
      const { dataStore } = this.slack.rtm;
      const user = dataStore.getUserById(event.user);
      logger.debug(`Slack user ${user.name} status changed to ${event.presence}.`);
      if (this.isBot(user.id)) return;
      if (event.presence === 'active') {
        this.newClient(user);
      } else {
        this.deleteClient(user);
      }
    });

    this.ircClient.on('message', this.sendToSlack.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      const formattedText = `*${text}*`;
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('action', (author, to, text) => {
      const formattedText = `_${text}_`;
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (this.ircStatusNotices.join) {
      this.ircClient.on('join', (channel, nick) => {
        if (nick !== this.nickname) {
          this.sendToSlack(this.nickname, channel, `*${nick}* has joined the IRC channel`);
        }
      });
    }

    if (this.ircStatusNotices.leave) {
      this.ircClient.on('part', (channel, nick) => {
        this.sendToSlack(this.nickname, channel, `*${nick}* has left the IRC channel`);
      });

      this.ircClient.on('quit', (nick, reason, channels) => {
        channels.forEach(channel => {
          this.sendToSlack(this.nickname, channel, `*${nick}* has quit the IRC channel`);
        });
      });
    }
  }

  parseText(text) {
    const { dataStore } = this.slack.rtm;
    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#(C\w+)\|?(\w+)?>/g, (match, channelId, readable) => {
        const { name } = dataStore.getChannelById(channelId);
        return readable || `#${name}`;
      })
      .replace(/<@(U\w+)\|?(\w+)?>/g, (match, userId, readable) => {
        const { name } = dataStore.getUserById(userId);
        return readable || `@${name}`;
      })
      .replace(/<(?!!)([^\|]+)>/g, (match, link) => link)
      .replace(/<!(\w+)\|?(\w+)?>/g, (match, command, label) =>
        `<${label || command}>`
      )
      .replace(/:(\w+):/g, (match, emoji) => {
        if (emoji in emojis) {
          return emojis[emoji];
        }

        return match;
      })
      .replace(/<.+\|(.+)>/g, (match, readable) => readable);
  }

  isBot(userId) {
    return this.slack.rtm.dataStore.getBotByUserId(userId) != null;
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  newClient(user) {
    logger.debug(`Connecting a new IRC client for Slack user ${user.name}.`);
    if (!(user.id in this.ircClients)) {
      const userOptions = Object.assign({}, this.ircOptions);
      userOptions.userName = user.name;
      if (this.ircClients[user.id] == null) {
        const client = new irc.Client(this.server, `${user.name}-slack`, userOptions);
        client.connect(5, msg => {
          if (msg.rawCommand === '001') {
            this.ircClients[user.id] = client;
            logger.debug(`User ${msg.args[0]} connected to IRC.`);
          } else {
            logger.debug(`Bot for ${user.name} could not connect to IRC.`);
          }
        });
      }
    }
  }

  deleteClient(user) {
    const client = this.ircClients[user.id];
    if (client != null) {
      client.disconnect(`User ${user.name} went away.`, () => {
        logger.debug(`Bot for Slack user ${user.name} disconnected.`);
        delete this.ircClients[user.id];
      });
    }
  }

  sendToIRC(message) {
    const { dataStore } = this.slack.rtm;
    const channel = dataStore.getChannelGroupOrDMById(message.channel);
    if (!channel) {
      logger.info('Received message from a channel the bot isn\'t in:',
        message.channel);
      return;
    }

    if (this.muteSlackbot && message.user === 'USLACKBOT') {
      logger.debug(`Muted message from Slackbot: "${message.text}"`);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const user = dataStore.getUserById(message.user);
      let text = this.parseText(message.text);

      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Slack by ${user.name}:`;
        this.ircClient.say(ircChannel, prelude);
      } else if (!message.subtype) {
        text = `<${user.name}> ${text}`;
      } else if (message.subtype === 'me_message') {
        text = `Action: ${user.name} ${text}`;
      }
      logger.debug('Sending message to IRC', channelName, text);
      this.ircClient.say(ircChannel, text);
    }
  }

  sendToSlack(author, channel, text) {
    const slackChannelName = this.invertedMapping[channel.toLowerCase()];
    if (slackChannelName) {
      const { dataStore } = this.slack.rtm;
      const name = slackChannelName.replace(/^#/, '');
      const slackChannel = dataStore.getChannelOrGroupByName(name);

      // If it's a private group and the bot isn't in it, we won't find anything here.
      // If it's a channel however, we need to check is_member.
      if (!slackChannel || (!slackChannel.is_member && !slackChannel.is_group)) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          slackChannelName);
        return;
      }

      const currentChannelUsernames = slackChannel.members.map(member =>
        dataStore.getUserById(member).name
      );

      const mappedText = currentChannelUsernames.reduce((current, username) =>
        highlightUsername(username, current)
      , text);

      let iconUrl;
      if (author !== this.nickname && this.avatarUrl) {
        iconUrl = this.avatarUrl.replace(/\$username/g, author);
      }

      const options = {
        username: author,
        parse: 'full',
        icon_url: iconUrl
      };

      logger.debug('Sending message to Slack', mappedText, channel, '->', slackChannelName);
      this.slack.web.chat.postMessage(slackChannel.id, mappedText, options);
    }
  }
}

export default Bot;
