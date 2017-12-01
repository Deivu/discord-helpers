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
        this._state = new Map();
        this._timeouts = new Map();
        this.searches = new Map();
        this._repository = repository;

        if (!fs.existsSync(`${BasePlayer.DOWNLOAD_DIR()}`)) {
            fs.mkdirSync(`${BasePlayer.DOWNLOAD_DIR()}`);
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
        let data = this._queue.get(guildID) || await this._repository.queue.get(guildID);
        if (data) {
            this._queue.set(guildID, data);
            return data;
        }
        return null;
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
    getMusicQueue(guild)
    {
        let queue = this._queue.get(guild.id);
        if (queue) return queue.tracks;
        return [];
    }

    /**
     * @param guild
     * @param position
     */
    removeTrack(guild, position)
    {
        let queue = this._queue.get(guild.id);
        if (position === 0) {
            queue.position = 0;
            queue.tracks = [];
            this.emit('remove', `Removing \`ALL\` tracks from the queue. Total: \`${queue.tracks.length}\``, guild);
        } else {
            if (position-1 >= queue.tracks.length) return this.emit('remove', `Invalid track number provided. Allowed: 1-${queue.tracks.length}`, guild);
            this.emit('remove', `Removing \`${queue.tracks[position-1].title}\` from the queue.`, guild);
            let firstHalf = position - 1 === 0 ? [] : queue.tracks.splice(0, position - 1);
            let secondHalf = queue.tracks.splice(position-1 === 0 ? position : position-1, queue.tracks.length);
            queue.tracks = firstHalf.concat(secondHalf);
        }
        this,_repository.queue.set(guild.id, 'tracks', queue.tracks);
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
    loadTrack(track, guild, userID = null)
    {
        return this.loadTracks([track], guild, userID);
    }

    /**
     *
     * @param tracks
     * @param guild
     * @param userID
     */
    loadTracks(tracks, guild, userID = null)
    {
        if (Array.isArray(tracks) === false) throw 'Tracks must be contained in array';
        for (let track of tracks) {
            this._validateTrackObject(track);
            track.added_by = userID;
        }

        let queue = this._queue.get(guild.id);
        if (!queue) throw 'Queue not preloaded at loadTracks()';

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