import _ from 'lodash';
import logger from 'winston';
/**
 * Sends a list of the users currently in the IRC channel in a DM to the requesting Slack user.
 * If query param is included, limits it to users containing the query and sends it to the channel.
 */
export function onlineIRCUsers(message, query) {
  const ircChannel = this.getIRCChannel(message.channel);
  logger.debug(`Getting online users for IRC channel ${ircChannel}`);

  this.ircClient.once('names', (chan, names) => {
    const userNames = _.keys(names);
    if (query == null) {
      // Send list of all users directly to user on .online
      // Open IM in case there isn't already an ongoing DM between the bot and the user
      this.slack.web.im.open(message.user, (response, data) => {
        const reply = `The following users are in ${ircChannel}: ${userNames.join(', ')}`;
        this.slack.rtm.sendMessage(reply, data.channel.id);
      });
    } else {
      const matched = [];
      for (const name of userNames) {
        if (name.indexOf(query) > -1) {
          matched.push(name);
        }
      }
      let reply = `No users are online matching '${query}'.`;
      if (matched.length > 0) {
        reply = `'${query}' matched the following users: ${matched.join(', ')}`;
      }
      this.slack.rtm.sendMessage(reply, message.channel);
    }
  });
  this.ircClient.send('NAMES', ircChannel);
}

/**
 * Retrieves the current IRC channel topic
 */
export function ircTopic(message) {
  const ircChannel = this.getIRCChannel(message.channel);
  logger.debug(`Requesting topic for IRC channel ${ircChannel}`);

  this.ircClient.once('topic', (chan, topic) => {
    this.slack.rtm.sendMessage(`IRC Topic:  ${topic}`, message.channel);
  });
  this.ircClient.send('TOPIC', ircChannel);
}

/**
 * Sends the available commands in a DM to the requesting user
 */
export function commandHelp(message) {
  logger.debug('Sending help command response.');
  // Open IM in case there isn't already an ongoing DM between the bot and the user
  this.slack.web.im.open(message.user, (response, data) => {
    const reply = '```.online [, query]``` ' +
      'Sends a list of all names in the IRC channel as a DM. ' +
      'If query parameter is provided, sends a list of partially matching nicks and displays ' +
      'them in the Slack channel.\n' +
      '```.topic``` ' +
      'Sends the IRC channel topic to the Slack channel.';
    this.slack.rtm.sendMessage(reply, data.channel.id);
  });
}
