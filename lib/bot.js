import _ from 'lodash';
import gist from 'quick-gist';
import irc from 'irc';
import request from 'request';
import logger from 'winston';
import { MemoryDataStore, RtmClient, WebClient, RTM_EVENTS,
  RTM_MESSAGE_SUBTYPES } from '@slack/client';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';
import { highlightUsername } from './helpers';
import { commandHelp, ircTopic, onlineIRCUsers, privMessage, resetIRC } from './commands';

const ALLOWED_SUBTYPES = ['me_message'];
const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];
const SLACK_REGEX = /@(\S+)/g;
const SERVER_NICKLEN = 16;
const CODE_REGEX = /```([^]*)```/;

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
    this.statusChanges = options.statusChanges || false;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.commandCharacters = options.commandCharacters || [];
    this.slackChannels = _.keys(options.channelMapping);
    this.ircChannels = _.values(options.channelMapping);
    this.muteSlackbot = options.muteSlackbot || false;
    this.nickSuffix = options.userNickSuffix || '-sl';
    this.nickRegex = new RegExp(`@?(\\S+${this.nickSuffix}\\d?)`, 'g');
    this.disconnectOnAway = options.disconnectOnAway || false;
    this.ircTimeout = options.ircTimeout || 120; // Seconds
    this.ircNameList = options.nameList;

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.ircChannels,
      autoConnect: false,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...options.ircOptions
    };
    this.ircOptions = ircOptions;
    this.ircClients = {};
    this.messageQueues = {};

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
        if (this.ircNameList != null) {
          this.startNamelist(this.ircChannels[0]);
        }
      } else {
        throw new Error('IRC bot could not connect.');
      }
    });
    this.attachListeners();
  }

  startNamelist(ircChannel) {
    setInterval(() => {
      this.ircClient.send('NAMES', ircChannel);
    }, this.ircNameList.interval * 1000);
  }

  attachListeners() {
    this.slack.rtm.on('open', () => {
      logger.debug('Connected to Slack');
      for (const key of this.slackChannels) {
        this.checkActiveUsers(key);
      }
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

    this.slack.rtm.on(RTM_EVENTS.MESSAGE, message => {
      // Ignore bot messages and people leaving/joining
      if (message.type === 'message' &&
        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)) {
        const { dataStore } = this.slack.rtm;
        const user = dataStore.getUserById(message.user);
        if (CODE_REGEX.test(message.text)) {
          const match = message.text.match(CODE_REGEX);
          gist({
            content: match[1],
            description: 'generated automatically from #selenium on freenode',
            public: false,
            }, (err, resp, data) => {
            if (err == null) {
              message.text = message.text.replace(match[0], data['html_url']);
            }
            this.queueMessage(user, message);
          });
        } else {
          this.queueMessage(user, message);
        }
      }
    });

    this.slack.rtm.on(RTM_EVENTS.USER_TYPING, message => {
      // Start up a client for the user once they start typing
      if (!(message.user in this.ircClients)) {
        const { dataStore } = this.slack.rtm;
        const user = dataStore.getUserById(message.user);
        this.connectNewClient(user)
      }
    });

    this.slack.rtm.on(RTM_EVENTS.PRESENCE_CHANGE, event => {
      // Connect/disconnect based on 'active'/'away' Slack status if option 'statusChanges' is set to true
      if (!this.statusChanges) return;
      const { dataStore } = this.slack.rtm;
      const user = dataStore.getUserById(event.user);
      logger.debug(`Slack user ${user.name} status changed to ${event.presence}.`);
      if (this.isBot(user.id)) return;
      const client = this.ircClients[user.id];
      if (event.presence === 'active') {
        if (client == null) {
          this.connectNewClient(user);
        } else if (this.disconnectOnAway) {
          this.clearAwayTimer(user);
        } else {
          client.send('AWAY');
        }
      } else if (client != null) {
        const awayMsg = `Slack user ${user.name} went away`;
        if (this.disconnectOnAway) {
          this.startAwayTimer(user, awayMsg);
        } else {
          client.send('AWAY', awayMsg);
        }
      }
    });

    this.slack.rtm.on(RTM_EVENTS.USER_CHANGE, event => {
      const { dataStore } = this.slack.rtm;
      const user = dataStore.getUserById(event.user.id);
      const client = this.ircClients[user.id];
      const ircNick = this.ircNick(user.name);
      if (event.user.presence !== 'active') return;
      if (client == null) {
        this.connectNewClient(event.user);
      } else if (ircNick !== client.nick) {
        logger.debug(`Slack user name change ${client.nick} -> ${ircNick}.`);
        client.send('NICK', ircNick);
        client.slackName = user.name;
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

    this.ircClient.on('kick', (chan, nick, by, reason) => {
      const reply = `${by} kicked ${nick} from IRC. (${reason})`;
      logger.debug(reply);
      const { dataStore } = this.slack.rtm;
      const botUser = dataStore.getUserById(this.slack.rtm.activeUserId);
      for (const key of _.keys(this.ircClients)) {
        if (this.ircClients[key].nick === nick) {
          this.sendToSlack(botUser.name, chan, reply);
          this.ircClients[key].disconnect();
          delete this.ircClients[key];
        }
      }
    });

    this.ircClient.on('names', (chan, names) => {
      if (this.ircNameList == null) return;
      const userNames = _.keys(names);
      const url = this.ircNameList.url;
      const key = this.ircNameList.key;
      userNames.sort((a, b) => {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
      request.post({
        url: url,
        form: {
          key: key,
          names: userNames.join(',')
        }
      }, (err, res, body) => {
        if (err != null) {
          logger.debug(body);
        }
      });
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
      .replace(SLACK_REGEX, (match, slackName) => {
        const ircNick = this.ircNick(slackName);
        if (this.currentShadowNicks().indexOf(ircNick) > -1) {
          return ircNick;
        }
        return match;
      })
      .replace(/<.+\|(.+)>/g, (match, readable) => readable);
  }

  ircNick(slackName) {
    return slackName.replace(/\./g, '-').substr(0, SERVER_NICKLEN - this.nickSuffix.length)
      + this.nickSuffix;
  }

  isBot(userId) {
    return this.slack.rtm.dataStore.getBotByUserId(userId) != null;
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  connectNewClient(user) {
    if (!(user.id in this.ircClients)) {
      const userOptions = Object.assign({}, this.ircOptions);
      userOptions.userName = user.name;
      if (this.ircClients[user.id] == null) {
        logger.debug(`Connecting a new IRC client for Slack user ${user.name}.`);
        this.newClient(user, userOptions);
      }
    }
  }

  newClient(user, options) {
    const client = new irc.Client(this.server, this.ircNick(user.name), options);
    this.attachUserListeners(user, client);
    this.ircClients[user.id] = client;
    client.slackName = user.name;
    client.userId = user.id;
    client.connected = false;
    client.connect(5, msg => {
      if (msg.rawCommand === '001') {
        client.connected = true;
        logger.debug(`User ${client.nick} connected to IRC.`);
        this.startAwayTimer(user, `Slack user ${user.name} went away`);
      } else {
        logger.debug(`Bot for ${user.name} could not connect to IRC.`);
      }
    });
  }

  deleteClient(user, message) {
    const client = this.ircClients[user.id];
    if (client != null) {
      if (client.conn != null) {
        client.disconnect(message, () => {
          logger.debug(`Bot for Slack user ${user.name} disconnected.`);
        });
      }
      delete this.ircClients[user.id];
    }
  }

  attachUserListeners(user, client) {
    client.on('error', error => {
      logger.error(`${user.name}: Received error event from IRC`, error);
      // Warn Slack user of invalid IRC username
      if (error.rawCommand === '432') {
        // Open IM in case there isn't already an ongoing DM between the bot and the user
        this.slack.web.im.open(user.id, (response, data) => {
          const reply = 'Your username is invalid for IRC and your ' +
            'messages will not be relayed until it is updated.';
          this.slack.rtm.sendMessage(reply, data.channel.id);
        });
        this.deleteClient(user, 'I experienced an error.');
      }
    });

    client.on('abort', () => {
      logger.error(`${user.name}: Maximum IRC retry count reached, exiting.`);
      delete this.ircClients[user.id];
    });

    // Queued messages are sent once we know the client is in a channel.
    client.on('names', () => {
      this.sendMessagesToIRC(user);
    });

    client.on('message', (author, channel, text) => {
      if (channel.startsWith('#')) return;
      if (client.userId) {
        this.slack.web.im.open(client.userId, (response, data) => {
          this.slack.web.chat.postMessage(data.channel.id, text, { username: author });
        });
      } else {
        client.say(author, 'There was an error sending your message.');
      }
    });
  }

  // Queue messsage for users prior to sending. This prevents the loss of messges while the IRC
  // client is still starting up for the user.
  queueMessage(user, message) {
    const { dataStore } = this.slack.rtm;
    const channel = dataStore.getChannelGroupOrDMById(message.channel);
    if (!channel) {
      logger.info(`Received message from a channel the user ${user.name} isn't in:`,
        message.channel);
      return;
    }
    this.messageQueues[user.id] = this.messageQueues[user.id] || {};
    const messageQueue = this.messageQueues[user.id];
    if (this.isCommandMessage(message.text)) {
      this.processCommandMessage(message);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];
    logger.debug(`Message queued -- ${user.name}: ${ircChannel}: ${message.text}`);
    if (ircChannel) {
      messageQueue[ircChannel] = messageQueue[ircChannel] || [];
      messageQueue[ircChannel].push(message);
    }

    this.sendMessagesToIRC(user);
  }

  sendMessagesToIRC(user) {
    const client = this.ircClients[user.id];
    const messageQueue = this.messageQueues[user.id];
    if (messageQueue == null) return;
    if (client == null) {
      this.connectNewClient(user);
      return;
    }
    if (!client.connected) return;

    this.restartAwayTimer(user, `Slack user ${user.name} went away`);
    for (const channel of _.keys(messageQueue)) {
      const messages = messageQueue[channel];
      while (messages.length > 0) {
        const message = messages.shift();
        let text = this.parseText(message.text);
        if (!message.subtype) {
          logger.debug(`${user.name}: Sending message to IRC`, channel, text);
          if (text.startsWith('/giphy') && message.attachments) {
            for (const attachment of message.attachments) {
              if (attachment.image_url) {
                text = `${text}: ${attachment.image_url}`;
              }
            }
          }
          client.say(channel, text);
        } else if (message.subtype === RTM_MESSAGE_SUBTYPES.ME_MESSAGE) {
          logger.debug(`${user.name}: Sending action to IRC`, channel, text);
          client.action(channel, text);
        }
      }
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

      // Don't relay a shadow user's IRC bot message back to Slack
      const currentShadowUsernames = this.currentShadowNicks();
      if (currentShadowUsernames.indexOf(author) > -1) {
        logger.debug(`Ignoring message from shadow user IRC bot '${author}'.`);
        return;
      }

      const replacedText = this.replaceUsernames(text);
      const convertedText = this.convertFormatting(replacedText);
      const mappedText = this.mapSlackUsers(slackChannel, convertedText);

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

  checkActiveUsers(slackChannelName) {
    // Start clients for currently active users if option 'statusChanges' is set to true
    if (!this.statusChanges) return;
    logger.debug(`Creating clients for active users on connect for channel ${slackChannelName}.`);
    const { dataStore } = this.slack.rtm;
    const name = slackChannelName.replace(/^#/, '');
    const slackChannel = dataStore.getChannelOrGroupByName(name);
    for (const member of slackChannel.members) {
      const user = dataStore.getUserById(member);
      if (user.presence === 'active') {
        this.connectNewClient(user);
      }
    }
  }

  currentChannelUsernames(slackChannel) {
    const { dataStore } = this.slack.rtm;
    return slackChannel.members.map(member =>
      dataStore.getUserById(member).name
    );
  }

  mapSlackUsers(slackChannel, text) {
    return this.currentChannelUsernames(slackChannel).reduce((current, username) =>
      highlightUsername(username, current)
    , text);
  }

  clientChannels(client) {
    return _.keys(client.chans).map(channel =>
      client.chans[channel].serverName
    );
  }

  currentShadowNicks() {
    return _.keys(this.ircClients).map(userId =>
      this.ircClients[userId].nick
    );
  }

  replaceUsernames(text) {
    return text.replace(this.nickRegex, (match, slackNick) => {
      for (const key of _.keys(this.ircClients)) {
        const client = this.ircClients[key];
        if (client.nick === slackNick) {
          return client.slackName;
        }
      }
      return match;
    });
  }

  convertFormatting(text) {
    const converted = text.replace(/\x03\d{2}(.+?)\x0F/g, '`$1`');
    return converted.replace(/\x02(.+?)\x0F/g, '*$1*');
  }

  getIRCChannel(slackChannelID) {
    const { dataStore } = this.slack.rtm;
    const channel = dataStore.getChannelGroupOrDMById(slackChannelID);
    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    return this.channelMapping[channelName];
  }

  startAwayTimer(user, message) {
    const client = this.ircClients[user.id];
    if (client != null) {
      client.timer = setTimeout(() => {
        this.deleteClient(user, message);
      }, this.ircTimeout * 1000);
    }
  }

  clearAwayTimer(user) {
    const client = this.ircClients[user.id];
    if (client != null) {
      clearTimeout(client.timer);
    }
  }

  restartAwayTimer(user, message) {
    this.clearAwayTimer(user);
    this.startAwayTimer(user, message);
  }

  processCommandMessage(message) {
    const commandString = message.text.substring(1);
    const regex = new RegExp('^(\\w+)\\s?(\\S+)?\\s?(.*)$', 'i');
    const match = commandString.match(regex);
    const onlineUsers = onlineIRCUsers.bind(this);
    const topic = ircTopic.bind(this);
    const help = commandHelp.bind(this);
    const priv = privMessage.bind(this);
    const resetIRCClient = resetIRC.bind(this);

    if (match == null) {
      return;
    }
    if (match.length > 1) {
      const command = match[1];
      const argument = match[2];
      const remaining = match[3];
      switch (command) {
        case 'online':
          onlineUsers(message, argument);
          break;
        case 'topic':
          topic(message);
          break;
        case 'reset':
          resetIRCClient(message);
          break;
        case 'msg':
          if (remaining) {
            priv(message, argument, remaining);
          } else {
            this.slack.rtm.sendMessage('You must supply a message.', message.channel);
          }
          break;
        case 'help':
          help(message);
          break;
        default:
          logger.debug('Invalid command received: ', command, argument);
      }
    }
  }
}

export default Bot;
