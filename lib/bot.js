import 'babel-polyfill';
import _ from 'lodash';
import Gists from 'gists';
import lang from 'language-classifier';
import irc from 'irc';
import request from 'request';
import logger from 'winston';
import { AllHtmlEntities } from 'html-entities';
import { RTMClient, WebClient } from '@slack/client';
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

const extensions = { ruby: 'rb',
  python: 'py',
  javascript: 'js',
  'objective-c': 'm',
  html: 'html',
  css: 'css',
  shell: 'sh',
  'c++': 'cpp',
  c: 'c',
  text: 'txt',
  markdown: 'md' };

  const userName = (user) => {
    return user.profile.display_name_normalized || user.name;
  };
  
  const channelName = (channel) => {
    return channel.name_normalized || channel.name;
  };

const asyncReplace = async (method, str, regex) => {
  const promises = [];

  str.replace(regex, (match, id) => {
    promises.push(method({ user: id }).then(resp => {
      return [id, `@${userName(resp.user)}`];
    }));
  });
  const results = await Promise.all(promises);
  const replacements = results.reduce((a, [id, name]) => {
    a[id] = name;
    return a;
  }, {});
  return str.replace(regex, (match, id, readable) => readable || replacements[id]);
};

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
    const rtm = new RTMClient(options.token);
    this.token = options.token;
    this.slack = { web, rtm };

    this.server = options.server;
    this.nickname = options.nickname;
    this.statusChanges = options.statusChanges || false;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.clientId = options.imgur.clientId || '';
    this.commandCharacters = options.commandCharacters || [];
    this.slackChannels = _.keys(options.channelMapping);
    this.ircChannels = _.values(options.channelMapping);
    this.muteSlackbot = options.muteSlackbot || false;
    this.nickSuffix = options.userNickSuffix || '-sl';
    this.nickRegex = new RegExp(`@?(\\S+${this.nickSuffix}\\d?)`, 'g');
    this.disconnectOnAway = options.disconnectOnAway || false;
    this.ircTimeout = options.ircTimeout || 120; // Seconds
    this.ircNameList = null;  // options.nameList;
    this.gistConfig = options.gists || {};

    this.ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.ircChannels,
      autoConnect: false,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...options.ircOptions
    };
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
    this.slack.rtm.start()
      .then((_resp) => { /* success */ })
      .catch((error) => { logger.debug(`Could not start RTM ${error}`); });

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
    this.gists = new Gists({ username: this.gistConfig.username,
      password: this.gistConfig.password });
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

    this.slack.rtm.on('message', message => {
      // Ignore bot messages and people leaving/joining
      if (message.type === 'message' && message.subtype !== 'bot_message') {
        logger.debug(JSON.stringify(message));
        const messageUser = message.user || message.message.user;
        this.slack.web.users.info({ user: messageUser }).then(resp => {
          const { user } = resp;
          if (message.files && /image/.test(message.files[0].mimetype)) {  // image attached
            this.sendImageMessage(message, user);
          } else if (message.files && message.files[0].mode === 'snippet') {  // code snippet attached
            this.sendSnippetMessage(message, user);
          } else if (message.subtype === 'message_changed') {
            const text = 'Notice: Message edits are not relayed to IRC.';
            this.slack.web.chat.postEphemeral({
              channel: message.channel,
              text,
              user: message.message.user,
              as_user: true
            }).then(_resp => { /* success */ })
              .catch(error => {
                logger.debug(`Error ${error} posting Ephemeral for message_changed`);
              });
          } else if (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1) {
            const final = message;
            if (CODE_REGEX.test(message.text)) {
              const match = message.text.match(CODE_REGEX);
              this.createGist({ content: match[1] }, (err, res) => {
                if (err == null) {
                  final.text = final.text.replace(match[0], res.html_url);
                }
                this.queueMessage(user, final);
              });
            } else {
              this.queueMessage(user, final);
            }
          }
        }).catch(error => { logger.debug(`Error ${error} getting users info in RTM on message`); });
      }
    });

    this.slack.rtm.on('member_joined_channel', message => {
      const text = 'Welcome! This channel has a two-way bridge to the #selenium IRC ' +
        'channel on freenode. Please see the pinned \'Interacting with IRC from Slack\' ' +
        'post for more information.';
      this.slack.web.chat.postEphemeral({ channel: message.channel,
        text,
        user: message.user,
        as_user: true })
        .then((_resp) => { /* success */ })
        .catch(error => { logger.debug(`Error ${error} posting Ephemeral in member_joined_channel`); });
    });

    this.slack.rtm.on('user_typing', event => {
      // Start up a client for the user once they start typing
      if (!(event.user in this.ircClients)) {
        this.slack.web.users.info({ user: event.user })
          .then((resp) => {
            this.connectNewClient(resp.user);
          })
          .catch(error => { logger.debug(`Error ${error} getting users info in user_typing event`); });
      }
    });

    this.slack.rtm.on('presence_change', event => {
      // Connect/disconnect based on 'active'/'away' Slack status
      // if option 'statusChanges' is set to true
      if (!this.statusChanges) return;
      this.slack.web.users.info({ user: event.user })
        .then(resp => {
          const user = resp.user;
          const name = userName(user);
          logger.debug(`Slack user ${name} status changed to ${event.presence}.`);
          this.isBot(user.id).then(isbot => {
            if (!isbot) {
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
                const awayMsg = `Slack user ${name} went away`;
                if (this.disconnectOnAway) {
                  this.startAwayTimer(user, awayMsg);
                } else {
                  client.send('AWAY', awayMsg);
                }
              }
            }
          })
          .catch(error => {
            logger.debug(`Error ${error} getting bot info in RTM presence_change event`);
          });
        })
        .catch(error => {
          logger.debug(`Error ${error} getting users info in RTM presence_change event`);
        });
    });

    this.slack.rtm.on('user_change', event => {
      logger.debug(`User change ${JSON.stringify(event)}`);
      this.slack.web.users.info({ user: event.user.id })
        .then(resp => {
          const user = resp.user;
          const name = userName(user);
          const client = this.ircClients[user.id];
          const ircNick = this.ircNick(name);
          if (client && ircNick !== client.nick) {
            logger.debug(`Slack user name change ${client.nick} -> ${ircNick}.`);
            client.send('NICK', ircNick);
            client.slackName = name;
          }
        })
        .catch(error => {
          logger.debug(`Error ${error} getting users info in RTM user_change event`);
        });
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
      this.slack.web.users.info({ user: this.slack.rtm.activeUserId })
        .then(resp => {
          const botUser = resp.user;
          for (const key of _.keys(this.ircClients)) {
            if (this.ircClients[key].nick === nick) {
              this.sendToSlack(userName(botUser), chan, reply);
              this.ircClients[key].disconnect();
              delete this.ircClients[key];
              this.updateSlackPresenceSubs();
            }
          }
        })
        .catch(error => { logger.debug(`Error ${error} getting users info in IRC kick event`); });
    });

    this.ircClient.on('names', (chan, names) => {
      if (this.ircNameList == null) return;
      const userNames = _.keys(names);
      const url = this.ircNameList.url;
      const key = this.ircNameList.key;
      userNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      request.post({
        url,
        form: {
          key,
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

  sendImageMessage(message, user) {
    const file = message.file || message.files[0];
    request.get({
      url: file.url_private_download,
      headers: { Authorization: `Bearer ${this.token}` },
      encoding: null
    }, (err, res, body) => {
      const final = message;
      if (err != null) {
        logger.debug(body);
      } else {
        const base64 = new Buffer(body, 'binary').toString('base64');
        request.post({
          url: 'https://api.imgur.com/3/image.json',
          form: { image: base64, type: 'base64' },
          headers: { authorization: `Client-ID ${this.clientId}` }
        }, (err2, res2, body2) => {
          if (err2 != null) {
            logger.debug(body2);
          } else {
            const json = JSON.parse(body2);
            final.text = `${message.text} (Attached image: ${json.data.link})`;
          }
          this.queueMessage(user, final);
        });
      }
    });
  }

  sendSnippetMessage(message, user) {
    const entities = new AllHtmlEntities();
    request.get({
      url: message.file.url_private,
      headers: { Authorization: `Bearer ${this.token}` }
    }, (err, res, body) => {
      if (err != null) {
        logger.debug(body);
      } else {
        this.createGist({
          filename: message.file.name,
          content: entities.decode(body)
        }, (err2, resp2) => {
          const final = message;
          if (err2 != null) {
            logger.debug(resp2);
          } else {
            final.text = `Added a ${final.file.pretty_type} snippet: ${resp2.html_url}`;
            if (final.file.comments_count > 0) {
              final.text += ` with comment: "${final.file.initial_comment.comment}"`;
            }
          }
          this.queueMessage(user, final);
        });
      }
    });
  }

  parseText(text) {
    const str = text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#C\w+\|?(\w+)?>/g, (match, readable) => `#${readable}`);
    return asyncReplace(this.slack.web.users.info, str, /<@(U\w+)\|?(\w+)?>/g)
      .then(str2 =>
        str2.replace(/<(?!!)([^|]+)>/g, (match, link) => link)
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
          .replace(/<.+\|(.+)>/g, (match, readable) => readable))
      .catch(error => { logger.debug(`Error ${error} in asyncReplace`); });
  }

  ircNick(slackName) {
    return slackName.replace(/\./g, '-').replace(/ /g, '-').substr(0, SERVER_NICKLEN - this.nickSuffix.length)
      + this.nickSuffix;
  }

  isBot(userId) {
    return this.slack.web.bots.info(userId)
      .then(resp => resp.bot !== undefined)
      .catch(error => { logger.debug(`Error ${error} getting users info in user_typing event`); });
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  connectNewClient(user) {
    if (!(user.id in this.ircClients)) {
      const userOptions = Object.assign({}, this.ircOptions);
      let name = userName(user);
      userOptions.userName = name.replace(/[^0-9a-z]/gi, '');
      if (this.ircClients[user.id] == null) {
        logger.debug(`Connecting a new IRC client for Slack user ${name}.`);
        this.newClient(user, userOptions);
      }
    }
  }

  newClient(user, options) {
    const name = userName(user);
    const client = new irc.Client(this.server, this.ircNick(name), options);
    this.attachUserListeners(user, client);
    this.ircClients[user.id] = client;
    this.updateSlackPresenceSubs();
    client.slackName = name;
    client.userId = user.id;
    client.connected = false;
    client.connect(5, msg => {
      if (msg.rawCommand === '001') {
        client.connected = true;
        logger.debug(`User ${client.nick} connected to IRC.`);
        this.startAwayTimer(user, `Slack user ${name} went away`);
      } else {
        logger.debug(`Bot for ${name} could not connect to IRC.`);
      }
    });
  }

  deleteClient(user, message) {
    const client = this.ircClients[user.id];
    const name = userName(user);
    logger.debug(`Deleting client for ${name} (${message}).`);
    if (client != null) {
      if (client.conn != null) {
        client.disconnect(message, () => {
          logger.debug(`Bot for Slack user ${name} disconnected.`);
        });
      }
      delete this.ircClients[user.id];
      this.updateSlackPresenceSubs();
    }
  }

  attachUserListeners(user, client) {
    client.on('error', error => {
      logger.error(`${userName(user)}: Received error event from IRC`, error);
      // Warn Slack user of invalid IRC username
      if (error.rawCommand === '432') {
        // Open IM in case there isn't already an ongoing DM between the bot and the user
        this.slack.web.im.open({ user: user.id }).then(resp => {
          const reply = 'Your username is invalid for IRC and your ' +
            'messages will not be relayed until it is updated.';
          this.slack.rtm.sendMessage(reply, resp.channel.id)
            .then(_resp => { /* success */ })
            .catch(err => { logger.debug(`Error ${err} sending RTM message in attachUserListeners`); });
        })
          .then(_resp => { /* success */ })
          .catch(webError => { logger.debug(`Error ${webError} opening IM in IRC client error`); });
        this.deleteClient(user, 'I experienced an error.');
      }
    });

    client.on('abort', () => {
      logger.error(`${userName(user)}: Maximum IRC retry count reached, exiting.`);
      this.deleteClient(user, 'IRC client aborted.');
    });

    // Queued messages are sent once we know the client is in a channel.
    client.on('names', () => {
      this.sendMessagesToIRC(user);
    });

    client.on('message', (author, channel, text) => {
      if (channel.startsWith('#')) return;
      if (client.userId) {
        this.slack.web.im.open({ user: client.userId })
          .then(resp => {
            this.slack.web.chat.postMessage({
              channel: resp.channel.id,
              text,
              username: author })
              .then(_resp => { /* success */ })
              .catch(error => { logger.debug(`Error ${error} posting message in IRC client message`); });
          })
          .catch(error => { logger.debug(`Error ${error} opening IM in IRC client message`); });
      } else {
        client.say(author, 'There was an error sending your message.');
      }
    });
  }

  // Queue messsage for users prior to sending. This prevents the loss of messges while the IRC
  // client is still starting up for the user.
  queueMessage(user, message) {
    const name = userName(user);
    this.slack.web.conversations.info({ channel: message.channel }).then(resp => {
      const { channel } = resp;
      if (message.thread_ts != null) {
        logger.debug(`Ignoring thread message: ${JSON.stringify(message)}`);
        return;
      }
      if (!channel) {
        logger.info(`Received message from a channel the user ${name} isn't in:`,
          message.channel);
        return;
      }
      this.messageQueues[user.id] = this.messageQueues[user.id] || {};
      const messageQueue = this.messageQueues[user.id];
      if (this.isCommandMessage(message.text)) {
        this.processCommandMessage(message);
        return;
      }
      let chanName = channelName(channel);
      chanName = channel.is_channel ? `#${chanName}` : chanName;
      const ircChannel = this.channelMapping[chanName];
      logger.debug(`Message queued -- ${chanName}: ${ircChannel}: ${message.text}`);
      if (ircChannel) {
        messageQueue[ircChannel] = messageQueue[ircChannel] || [];
        messageQueue[ircChannel].push(message);
      }

      this.sendMessagesToIRC(user);
    }).catch(error => { logger.debug(`Error ${error} getting channel info in queueMessage`); });
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

    const name = userName(user);
    this.restartAwayTimer(user, `Slack user ${name} went away`);
    for (const channel of _.keys(messageQueue)) {
      const messages = messageQueue[channel];
      while (messages.length > 0) {
        const message = messages.shift();
        this.parseText(message.text).then(text => {
          let final = text;
          if (!message.subtype || message.subtype === 'file_share') {
            logger.debug(`${name}: Sending message to IRC`, channel, text);
            if (text.startsWith('/giphy') && message.attachments) {
              for (const attachment of message.attachments) {
                if (attachment.image_url) {
                  final = `${text}: ${attachment.image_url}`;
                }
              }
            }
            client.say(channel, final);
          } else if (message.subtype === 'me_message') {
            logger.debug(`${name}: Sending action to IRC`, channel, text);
            client.action(channel, text);
          }
        }).catch(error => { logger.debug(`Error ${error} parsing text in sendMessagesToIRC`); });
      }
    }
  }

  sendToSlack(author, channel, text) {
    const slackChannelName = this.invertedMapping[channel.toLowerCase()];
    if (slackChannelName) {
      const name = slackChannelName.replace(/^#/, '');
      this.getSlackChannelByName(name).then(slackChannel => {
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
          channel: slackChannel.id,
          text: mappedText,
          username: author,
          parse: 'full',
          icon_url: iconUrl,
          as_user: 'false'
        };

        logger.debug('Sending message to Slack', mappedText, channel, '->', slackChannelName);
        this.slack.web.chat.postMessage(options).then(_resp => { /* success */ });
      }).catch(error => { logger.debug(`Error ${error} getting channel by name in sendToSlack`); });
    }
  }

  getSlackChannelByName(name) {
    return this.slack.web.conversations.list().then(resp => {
      const { channels } = resp;
      let slackChannel;
      for (const chan of channels) {
        if (channelName(chan) === name) {
          slackChannel = chan;
        }
      }
      return slackChannel;
    }).catch(error => {
      logger.debug(`Error ${error} getting channel list in getSlackChannelByName`);
    });
  }

  updateSlackPresenceSubs() {
    this.slack.rtm.subscribePresence(_.keys(this.ircClients))
      .then(_resp => { /* success */ })
      .catch(error => logger.debug(`Error ${error} subscribing presence`));
  }

  checkActiveUsers(slackChannelName) {
    // Start clients for currently active users if option 'statusChanges' is set to true
    if (!this.statusChanges) return;
    logger.debug(`Creating clients for active users on connect for channel ${slackChannelName}.`);
    const name = slackChannelName.replace(/^#/, '');
    this.getSlackChannelByName(name).then(slackChannel => {
      for (const member of slackChannel.members) {
        this.slack.web.users.info({ user: member}).then(resp => {
          const user = resp.user;
          if (user.presence === 'active') {
            this.connectNewClient(user);
          }
        });
      }
    }).catch(error => { logger.debug(`Error ${error} getting channel by name in checkActiveUsers`); });
  }

  currentChannelUsernames(slackChannel) {
    return slackChannel.members.map(member =>
      this.slack.web.users.info({ user: member })
        .then(resp => userName(resp.user))
        .catch(error => {
          logger.debug(`Error ${error} getting users info in currentChannelUsernames`);
        })
    );
  }

  mapSlackUsers(slackChannel, text) {
    return this.currentSlackNames(slackChannel).reduce((current, username) =>
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

  currentSlackNames() {
    return _.keys(this.ircClients).map(userId =>
        this.ircClients[userId].slackName
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
    return this.slack.web.conversations.info({ channel: slackChannelID }).then(resp => {
      const { channel } = resp;
      let chanName = channelName(channel);
      chanName = channel.is_channel ? `#${chanName}` : chanName;
      return this.channelMapping[chanName];
    }).catch(error => { logger.debug(`Error ${error} getting channel info in getIRCChannel`); });
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
            this.slack.rtm.sendMessage('You must supply a message.', message.channel)
              .then(_resp => { /* success */ })
              .catch(error => { logger.debug(`Error ${error} sending RTM message in processCommandMessage`); });
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

  createGist(obj, cb) {
    const entities = new AllHtmlEntities();
    const files = {};
    const language = lang(obj.content) || 'text';
    const filename = obj.filename || `file.${extensions[language]}`;
    files[filename] = { content: entities.decode(obj.content) };
    const options = {
      description: 'generated automatically from #selenium on seleniumhq slack',
      public: true,
      files
    };
    this.gists.create(options, cb);
  }
}

export default Bot;
