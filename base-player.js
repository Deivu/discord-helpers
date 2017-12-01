const ffmpeg = require('fluent-ffmpeg');
const promise = require('promised-io/promise');
const fs = require('fs');
const EventEmitter = require('events');

module.exports = class BasePlayer extends EventEmitter
{
    static DOWNLOAD_DIR() {return 'downloads'};

    constructor(youtube, repository)
    {
        super();
        this._youtube = youtube;
        this._queue = new Map();
        this.messages = new Map();
        this._state = new Map();
        this._timeouts = new Map();
        this.searches = new Map();
        this._repository = repository;

        if (!fs.existsSync(`${BasePlayer.DOWNLOAD_DIR()}`)) {
            fs.mkdirSync(`${BasePlayer.DOWNLOAD_DIR()}`);
        }
    }

    /**
     * @param guild
     * @param message
     */
    savePlayerMessage(guild, message)
    {
        this.messages.set(guild.id, message);
    }

    /**
     *
     * @param guildID
     * @private
     */
    _deletePlaybackMessage(guildID)
    {
        let message = this.messages.get(guildID);
        if (message) {
            message.delete();
            this.messages.delete(guildID);
        }
    }

    /**
     * Basically loads music data into memory if not found
     * @param guildID
     * @returns {Promise.<*>}
     * @private
     */
    async _preload(guildID)
    {
        let queue = this._queue.get(guildID);
        if (!queue) {
            queue =  await this._repository.queue.get(guildID);
            this._queue.set(guildID, queue);
        }
        //todo later add settings preloader
        return queue;
    }

    /**
     * Terminates state
     */
    terminate()
    {
        this._initDefaultState();
    }

    /**
     *
     * @param guild
     * @returns {*}
     */
    async getMusicQueue(guild)
    {
        let queue = await this._preload(guild.id)
        if (queue) return queue.tracks;
        return [];
    }

    /**
     * @param guild
     * @param position
     */
    async removeTrack(guild, position)
    {
        let queue = await this._preload(guild.id)
        if (position === 'all') {
            this.emit('remove', `Removing \`ALL\` tracks from the queue. Total: \`${queue.tracks.length}\``, guild);
            queue.position = 0;
            queue.tracks = [];
        } else {
            if (position-1 >= queue.tracks.length) return this.emit('remove', `Invalid track number provided. Allowed: 1-${queue.tracks.length}`, guild);
            this.emit('remove', `Removing \`${queue.tracks[position-1].title}\` from the queue.`, guild);
            let firstHalf = position - 1 === 0 ? [] : queue.tracks.splice(0, position - 1);
            let secondHalf = queue.tracks.splice(position-1 === 0 ? position : position-1, queue.tracks.length);
            queue.tracks = firstHalf.concat(secondHalf);
        }
        this._repository.queue.set(guild.id, 'tracks', queue.tracks);
        this._queue.set(guild.id, queue);
    }

    /**
     *
     * @param array
     * @returns {*}
     * @private
     */
    _randomizeArray(array)
    {
        if (array.length >= 2) {
            for (let i = array.length - 1; i > 0; i--) {
                let j = Math.floor(Math.random() * (i + 1));
                let temp = array[i];
                array[i] = array[j];
                array[j] = temp;
            }
        }
        return array;
    }

    /**
     *
     * @param guildID
     * @param stream
     * @returns {Promise|PromiseConstructor}
     * @private
     */
    _convertToAudio(guildID, stream)
    {
        let deferred = promise.defer();

        (new ffmpeg(stream))
            .noVideo()
            .saveToFile(`${BasePlayer.DOWNLOAD_DIR()}/${guildID}.mp3`)
            .on('error', (e) => {
                console.log(e);
                deferred.reject(e);
            })
            .on('end', () => {
                deferred.resolve(true);
            });

        return deferred.promise;
    }

    /**
     * @param track
     * @param guild
     * @param userID
     */
    async loadTrack(track, guild, userID = null)
    {
        return await this.loadTracks([track], guild, userID);
    }

    /**
     *
     * @param tracks
     * @param guild
     * @param userID
     */
    async loadTracks(tracks, guild, userID = null)
    {
        if (Array.isArray(tracks) === false) throw 'Tracks must be contained in array';
        for (let track of tracks) {
            this._validateTrackObject(track);
            track.added_by = userID;
        }

        let queue = this._queue.get(guild.id);
        if (!queue) {
            queue = await this._preload(guild.id);
            if (!queue) throw 'failed to preload queue! Missing migration?';
        }

        queue.tracks = queue.tracks.concat(tracks);
        this._repository.queue.set(guild.id, 'tracks', queue.tracks);

        this._queue.set(guild.id, queue);

        this.emit('update', guild);
    }

    /**
     * @param guildID
     * @private
     */
    _initDefaultState(guildID)
    {
        let state = {
            passes: 2,
            seek: 0,
            volume: 1,
            increment_queue: true,
            loop: true,
            shuffle: true,
            stop: false,
        };
        this._state.set(guildID, state);

        return state;
    }

    /**
     *
     * @param id
     * @private
     */
    _incrementTimeout(id)
    {
        let timeout = this._timeouts.get(id) || {count: 0};
        timeout.count++;
        this._timeouts.set(id, timeout);
    }
    /**
     *
     * @param guildID
     * @private
     */
    _TryToIncrementQueue(guildID)
    {
        let queue = this._queue.get(guildID);
        let state = this._state.get(guildID);

        if (!queue) throw 'Can\'t increment queue - map not initialized';
        if (queue.position >= queue.tracks.length-1 && state.increment_queue === true) {
            queue.queue_end_reached = true;
            this._repository.queue.set(guildID, 'queue_end_reached', true);
        } else if (!state || state.increment_queue === true) {
            queue.position+=1;
            this._repository.queue.set(guildID, 'position', queue.position);
        }

        state.increment_queue = true;

        this._state.set(guildID, state);
        this._queue.set(guildID, queue);
    }

    /**
     * @param guildID
     * @private
     */
    _resetQueuePosition(guildID)
    {
        let queue = this._queue.get(guildID);
        queue.position = 0;
        queue.queue_end_reached = false;
        this._queue.set(guildID, queue);

        this._repository.queue.setMultiple(guildID, new Map([['position', 0], ['queue_end_reached', false]]));
    }

    /**
     *
     * @param track
     * @returns {boolean}
     * @private
     */
    _validateTrackObject(track)
    {
        if (!track) throw 'No track object passed';
        if (!track.title) throw 'Track object must specify track name [track.title]';
        if (!track.url) throw 'Track must specify stream url [track.url]';
        if (!track.source) throw 'Track must specify stream source [track.source]';
        if (!track.image) throw 'Track must specify stream image [track.image]';

        return true;
    }

    /**
     *
     * @param queue
     * @returns {*}
     * @private
     */
    _getTrack(queue)
    {
        let track = queue.tracks[queue.position];
        track['position'] = queue.position;
        track['total'] = queue.tracks.length;

        return track;
    }
};