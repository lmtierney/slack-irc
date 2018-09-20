import _ from 'lodash';
import logger from 'winston';
/**
 * Sends a list of the users currently in the IRC channel in a DM to the requesting Slack user.
 * If query param is included, limits it to users containing the query and sends it to the channel.
 */
export function onlineIRCUsers(message, query) {
  this.getIRCChannel(message.channel).then(ircChannel => {
    if (ircChannel == null) return;
    logger.debug(`Getting online users for IRC channel ${ircChannel}`);
    this.ircClient.once('names', (chan, names) => {
      const userNames = _.keys(names);
      if (query == null) {
        // Send list of all users directly to user on .online
        // Open IM in case there isn't already an ongoing DM between the bot and the user
        this.slack.web.im.open({ user: message.user })
          .then(resp => {
            userNames.sort();
            const reply = `The following users are in ${ircChannel}: ${userNames.join(', ')}`;
            this.slack.rtm.sendMessage(reply, resp.channel.id);
          }).catch(error => { logger.debug(`Error ${error} opening IM in onlineIRCUsers`); });
      } else {
        const matched = [];
        for (const name of userNames) {
          if (name.match(RegExp(query, 'i')) !== null) {
            matched.push(name);
          }
        }
        let reply = `No users are online matching '${query}'.`;
        if (matched.length > 0) {
          matched.sort();
          reply = `'${query}' matched the following users: ${matched.join(', ')}`;
        }
        this.slack.rtm.sendMessage(reply, message.channel)
          .then(_resp => { /* success */ })
          .catch(error => { logger.debug(`Error ${error} sending RTM message in onlineIRCUsers`); });
      }
    });
    this.ircClient.send('NAMES', ircChannel);
  }).catch(error => { logger.debug(`Error ${error} getting IRCChannel in onlineIRCUsers`); });
}

/**
 * Retrieves the current IRC channel topic
 */
export function ircTopic(message) {
  this.getIRCChannel(message.channel).then(ircChannel => {
    if (ircChannel == null) return;
    logger.debug(`Requesting topic for IRC channel ${ircChannel}`);

    this.ircClient.once('topic', (chan, topic) => {
      this.slack.rtm.sendMessage(`IRC Topic:  ${topic}`, message.channel)
        .then(_resp => { /* success */ })
        .catch(error => { logger.debug(`Error ${error} sending RTM message in ircTopic`); });
    });
    this.ircClient.send('TOPIC', ircChannel);
  }).catch(error => { logger.debug(`Error ${error} getting IRCChannel in onlineIRCUsers`); });
}

/**
 * Reconnects the IRC client for the requesting user
 */
export function resetIRC(message) {
  this.slack.web.users.info({ user: message.user }).then(resp => {
    const { user } = resp;
    this.deleteClient(user, 'Resetting...');
    this.connectNewClient(user);
    this.slack.rtm.sendMessage(`Resetting IRC client for ${user.profile.display_name_normalized}...`, message.channel)
      .then(_resp => { /* success */ })
      .catch(error => { logger.debug(`Error ${error} sending RTM message in resetIRC`); });
  }).catch(error => { logger.debug(`Error ${error} getting users info in resetIRC`); });
}

/**
 * Sends the available commands in a DM to the requesting user
 */
export function commandHelp(message) {
  logger.debug('Sending help command response.');
  // Open IM in case there isn't already an ongoing DM between the bot and the user
  console.log(JSON.stringify(message));
  console.log(message.user);
  this.slack.web.im.open({ user: message.user }).then(resp => {
    this.slack.web.users.info({ user: this.slack.rtm.activeUserId }).then(resp2 => {
      const reply = '```.online [, query]``` ' +
        'Sends a list of all names in the IRC channel as a DM. ' +
        'If query parameter is provided, sends a list of partially matching nicks and displays ' +
        'them in the Slack channel.\n' +
        '```.topic``` ' +
        'Sends the IRC channel topic to the Slack channel.' +
        '```.reset``` ' +
        'Resets the IRC client for the requesting user.' +
        '```.msg ircNick message``` ' +
        'Sends a private message to the specified ircNick. Send the command in this Direct ' +
        'Message to the bot ' +
        `(${resp2.profile.display_name_normalized}).` +
        '```.help``` ' +
        'Displays this message.';
      this.slack.rtm.sendMessage(reply, resp.channel.id)
        .then(_resp => { /* success */ })
        .catch(error => { logger.debug(`Error ${error} sending RTM message in commandHelp`); });
    }).catch(error => { logger.debug(`Error ${error} getting users info in commandHelp`); });
  }).catch(error => { logger.debug(`Error ${error} opening IM in commandHelp`); });
}


/**
 * Sends a private message to the IRC user
 */
export function privMessage(message, ircUser, msg) {
  if (!message.channel.startsWith('D')) {
    // Warn user to use the bot DM
    // Open IM in case there isn't already an ongoing DM between the bot and the user
    this.slack.web.im.open({ user: message.user }).then(resp => {
      const reply = 'The `.msg` command should be used through this DM only, ' +
          'using it in an open channel allows visibility to all in that channel. ' +
          'Your original message has not been sent to the user and you may want to delete it from the public channel.';
      this.slack.rtm.sendMessage(reply, resp.channel.id)
        .then(_resp => { /* success */ })
        .catch(error => { logger.debug(`Error ${error} sending RTM message in privMessage`); });
    }).catch(error => { logger.debug(`Error ${error} opening IM in privMessage`); });
  } else {
    logger.debug(`Sending private message to ${ircUser}.`);
    const messageQueue = this.messageQueues[message.user];

    this.slack.web.users.info({ user: message.user }).then(resp => {
      const { user } = resp;
      this.ircClient.whois(ircUser, (res) => {
        if (res.host) {
          messageQueue[ircUser] = messageQueue[ircUser] || [];
          messageQueue[ircUser].push({ text: msg });
          this.sendMessagesToIRC(user);
        } else {
          this.slack.rtm.sendMessage(`\`${ircUser}\` is not online.`, message.channel)
            .then(_resp => { /* success */ })
            .catch(error => { logger.debug(`Error ${error} sending RTM message in privMessage`); });
        }
      });
    });
  }
}
