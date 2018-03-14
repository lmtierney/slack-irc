# SeleniumHQ slack-irc 

This is a bot specifically tailored to the SeleniumHQ community. It allows for a Slack <-> IRC communication by creating an IRC bot user for each Slack user. The original project can be found at https://github.com/ekmartin/slack-irc.


## Installation and usage

Clone the repository:

```bash
$ git clone https://github.com/lmtierney/slack-irc.git && cd slack-irc
$ npm install
$ npm run build
$ npm start -- --config /path/to/config.json # Note the extra -- here
```

It can also be used as a node module:
```js
var slackIRC = require('slack-irc');
var config = require('./config.json');
slackIRC(config);
```

## Configuration

slack-irc uses Slack's [bot users](https://api.slack.com/bot-users).
This means you'll have to set up a bot user as a Slack integration, and invite it
to the Slack channels you want it to listen in on. This can be done using Slack's `/invite <botname>`
command. This has to be done manually as there's no way to do it through the Slack bot user API at
the moment.

slack-irc requires a JSON-configuration file, whose path can be given either through
the CLI-option `--config` or the environment variable `CONFIG_FILE`. The configuration
file needs to be an object or an array, depending on the number of IRC bots you want to run.

This allows you to use one instance of slack-irc for multiple Slack teams if wanted, even
if the IRC channels are on different networks.

To set the log level to debug, export the environment variable `NODE_ENV` as `development`.

slack-irc also supports invite-only IRC channels, and will join any channels it's invited to
as long as they're present in the channel mapping.

### Example configuration
Valid JSON cannot contain comments, so remember to remove them first!
```js
[
  // Bot 1 (minimal configuration):
  {
    "nickname": "test2",
    "server": "irc.testbot.org",
    "token": "slacktoken2",
    "channelMapping": {
      "#other-slack": "#new-irc-channel"
    }
  },

  // Bot 2 (advanced options):
  {
    "nickname": "test",
    "server": "irc.bottest.org",
    "token": "slacktoken", // Your bot user's token
    "avatarUrl": "https://robohash.org/$username.png?size=48x48", // Set to false to disable Slack avatars
    "autoSendCommands": [ // Commands that will be sent on connect
      ["PRIVMSG", "NickServ", "IDENTIFY password"],
      ["MODE", "test", "+x"],
      ["AUTH", "test", "password"]
    ],
    "channelMapping": { // Maps each Slack-channel to an IRC-channel, used to direct messages to the correct place
      "#slack": "#irc channel-password", // Add channel keys after the channel name
      "privategroup": "#other-channel" // No hash in front of private groups
    },
    "ircOptions": { // Optional node-irc options
      "floodProtection": false, // On by default
      "floodProtectionDelay": 1000 // 500 by default
    },
    // Makes the bot hide the username prefix for messages that start
    // with one of these characters (commands):
    "commandCharacters": ["!", "."],
    // Prevent messages posted by Slackbot (e.g. Slackbot responses)
    // from being posted into the IRC channel:
    "muteSlackbot": true, // Off by default
    // Sends messages to Slack whenever a user joins/leaves an IRC channel:
    "ircStatusNotices": {
      "join": false, // Don't send messages about joins
      "leave": true
    }
  }
]
```

`ircOptions` is passed directly to node-irc ([available options](http://node-irc.readthedocs.org/en/latest/API.html#irc.Client)).

## Development
To be able to use the latest ES2015+ features, slack-irc uses [Babel](https://babeljs.io).

Build the source with:
```bash
$ npm run build
```

### Tests
Run the tests with:
```bash
$ npm test
```
