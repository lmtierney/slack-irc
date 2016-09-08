import _ from 'lodash';
/**
 * Sends a list of the users currently in the IRC channel in a DM to the requesting Slack user.
 * If query param is included, limits it to users containing the query and sends it to the channel.
 */
export function onlineIRCUsers(message, query) {
  const { dataStore } = this.slack.rtm;
  const channel = dataStore.getChannelGroupOrDMById(message.channel);
  const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
  const ircChannel = this.channelMapping[channelName];

  // Open IM in case there isn't already an ongoing DM between the bot and the user
  this.slack.web.im.open(message.user, (response, data) => {
    this.ircClient.once('names', (chan, names) => {
      const userNames = _.keys(names);
      if (query == null) {
        const reply = `The following users are in ${ircChannel}: ${userNames.join(', ')}`;
        this.slack.rtm.sendMessage(reply, data.channel.id);
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
  });
}
