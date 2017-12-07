const EventEmitter = require('events');
const Discord = require('discord.js');
const Repository = require('discord-mongo-wrappers/repositories/guild-setting-repository');

module.exports = class RadioPlayer extends EventEmitter
{
    /**
     *
     * @param listenMoe
     * @param config
     * @param repository
     */
    constructor(listenMoe, config, repository)
    {
        super();
        this._listenMoe = listenMoe;
        this._listenMoe.openSocket();
        this._messages = new Map();
        this._state = new Map();
        this._repository = repository;
        this.config = config;
    }

    /**
     *
     * @param guildID
     * @private
     */
    _deletePlaybackMessage(guildID)
    {
        let message = this._messages.get(guildID);
        if (message) {
            message.delete();
            this._messages.delete(guildID);
        }
    }


    /**
     *
     * @param guild
     * @param message
     */
    savePlayerMessage(guild, message)
    {
        this._messages.set(guild.id, message);
    }

    /**
     *
     * @param guild
     * @returns {PromiseConstructor | Promise}
     */
    async stream(guild)
    {
        let connection = guild.voiceConnection;
        if (connection && this._state.get(guild.id)) return this.emit('stream', 'I am already playing radio.', guild);
        if (connection && connection.dispatcher) connection.dispatcher.destroy('radio-player', 'next');
        let state = await this._preload(guild.id);

        let dispatcher = connection.playStream(this.config.stream, {passes: state.passes || 2 , volume: state.volume || 0.5});
        dispatcher.on('start', () => {
            this._state.set(guild.id, {listening: true});
            this.emit('streaming', this.getInfo(guild), guild);
        });
        dispatcher.on('end', (reason) => {
            console.log("Dispatcher end event", reason);
            this._deletePlaybackMessage(guild.id);
            this._state.delete(guild.id);
        });
        dispatcher.on('error', (reason) => {
            console.log('Dispatcher error event:', reason);
            this._state.delete(guild.id);
        });

        this._listenMoe.socket.on(`update`, data => {
            let state = this._state.get(guild.id);
            if (state && state.listening)  {
                this._state.set(guild.id, {listening: true});
                if (connection.channel.members.size === 1) {
                    let msg = this._messages.get(guild.id);
                    if (msg && msg.deletable) {
                        msg.delete();
                    }
                    connection.disconnect();
                    this.emit('stream', 'No users in voice channel. Turning off radio for now.', guild);
                    this._state.delete(guild.id);
                } else this.emit('streaming', this.getInfo(guild), guild);
            }
        });

    }

    /**
     * @param guild
     * @returns {*}
     */
    getInfo(guild)
    {
        let data = this._listenMoe.socket.info;
        let connection = guild.voiceConnection;
        if (connection && connection.dispatcher) {
            let embed = new Discord.RichEmbed();
            embed
                .setAuthor(`Playing - 🎵 ${data.artist_name.toUpperCase()} - ${data.song_name.toUpperCase()} 🎵`, this.config.image, this.config.url)
                .setColor('RANDOM')
                .addField('Author', `${data.last.artist_name} - ${data.last.song_name}`, true)
                .addField('Requested By', data.requested_by || 'Unknown', true)
                .setImage(this.config.image)
                .setTimestamp();
            return embed;
        }
        return null;
    }

    /**
     *
     * @param guildID
     * @returns {{volume: (string|Number), passes: (string|Number)}}
     * @private
     */
    async _preload(guildID)
    {
        let state = this._state.get(guildID);
        let settingsMap = await this._repository.setting.getSettings(guildID);

        if (!state || settingsMap.get(Repository.SETTING_FORCED_STATE_RESYNC()).value === true || state.forced_resync === true) {
            state = {
                volume: settingsMap.get(Repository.SETTING_DEFAULT_AUDIO_DISPATCHER_VOLUME()).value,
                passes: settingsMap.get(Repository.SETTING_MUSIC_PLAYER_QUALITY_PASSES()).value,
                forced_resync: false,
                listening: true
            };
            this._repository.setting.setSetting(guildID, Repository.SETTING_FORCED_STATE_RESYNC(), false);
            this._state.set(guildID, state);
        }
        return state;
    }
};