import initModule from './streaming-engine/target/wasm32-unknown-emscripten/release/streaming-engine.js';
let wasm = null;
let wasmLoading = null;
let liveEngineCount = 0;

async function ensureWasm() {
    if (wasm) return wasm;
    if (!wasmLoading) {
        wasmLoading = Promise.resolve(initModule()).then(module => {
            wasm = module;
            return module;
        }).finally(() => { wasmLoading = null; });
    }
    return wasmLoading;
}

const MSE = window.ManagedMediaSource || window.MediaSource;

function isMseTypeSupported(mime) {
    try { return Boolean(MSE?.isTypeSupported?.(mime)); }
    catch (e) { return false; }
}

// Clear ASS subtitles
function cleanSubtitleText(codec, rawText) {
    if (codec === "S_TEXT/ASS" || codec === "S_TEXT/SSA") {
        const parts = rawText.split(',');
        if (parts.length >= 9) {
            let text = parts.slice(8).join(',');
            text = text.replace(/\\N/gi, '\n');
            text = text.replace(/\{[^}]+\}/g, '');
            return text;
        }
    }
    // S_TEXT/UTF8 (SRT) comes through completely clean out of the box!
    return rawText;
}

// Reuse one channel instead of allocating two message ports on every yield.
let yieldChannel;
const yieldCallbacks = [];
const yieldThread = () => new Promise(resolve => {
    if (!yieldChannel) {
        yieldChannel = new MessageChannel();
        yieldChannel.port1.onmessage = () => yieldCallbacks.shift()?.();
    }
    yieldCallbacks.push(resolve);
    yieldChannel.port2.postMessage(null);
});

// Memory unlocker
function getWasmMemory() {
    if (wasm.HEAPU8 && wasm.HEAPU8.buffer) return wasm.HEAPU8.buffer;
    if (wasm.asm && wasm.asm.memory && wasm.asm.memory.buffer) return wasm.asm.memory.buffer;
    if (wasm.memory && wasm.memory.buffer) return wasm.memory.buffer;
    if (wasm.wasmMemory && wasm.wasmMemory.buffer) return wasm.wasmMemory.buffer;
    console.error("WASM Object Dump:", wasm);
    throw new Error("Emscripten memory buffer not found.");
}

const RANGE_FETCH_TIMEOUT_MS = 15000;
const STREAM_BUFFER_TARGET_SECONDS = 30;
const STREAM_BUFFER_RESUME_SECONDS = 15;
// Bound synchronous Wasm calls separately from HTTP ranges. Budgets persist
// across reader chunks, including reads that resolve without an event-loop turn.
const PARSE_SLICE_BYTES = 256 * 1024;
const PARSE_YIELD_BYTES = 1024 * 1024;
const PARSE_YIELD_MS = 4;
const SEGMENT_VIDEO_FRAMES = 30;
const SEGMENT_DURATION_MS = 1000;
const SEGMENT_MEDIA_BYTES = 4 * 1024 * 1024;

class FetchWatchdog {
    constructor(timeoutMs, externalSignal) {
        this.controller = new AbortController();
        this.timeoutMs = timeoutMs;
        this._timer = null;
        this._externalSignal = externalSignal || null;
        this._onExternalAbort = () => this.controller.abort(externalSignal.reason);

        if (this._externalSignal) {
            if (this._externalSignal.aborted) this.controller.abort(this._externalSignal.reason);
            else this._externalSignal.addEventListener('abort', this._onExternalAbort);
        }
        this.bump();
    }

    get signal() { return this.controller.signal; }

    bump() {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this.controller.abort(new DOMException(
                `No response/activity for ${this.timeoutMs}ms — treating connection as stalled.`,
                'TimeoutError'
            ));
        }, this.timeoutMs);
    }

    pause() { clearTimeout(this._timer); }

    dispose() {
        this.pause();
        if (this._externalSignal) this._externalSignal.removeEventListener('abort', this._onExternalAbort);
    }
}

class MKVFetcher {
    constructor(source) {
        this.source = source;
        this.type = source instanceof File ? 'file' : 'url';
        this.size = Infinity;
        this.stats = { rangeRequests: 0, rangeBytesRequested: 0, streamReads: 0,
            streamBytesRead: 0, streamBytesDelivered: 0, earlyRangeStops: 0 };
    }

    // SETS SIZE REGARDLESS OF TYPE
    async init() {
        if (this.source instanceof File) {
            this.type = 'file';
            this.size = this.source.size;
            return;
        }

        let finalSize = null;

        // Phase 1: Try HEAD
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const headRes = await fetch(this.source, { method: 'HEAD', signal: controller.signal });
            clearTimeout(timeoutId);

            const length = parseInt(headRes.headers.get('content-length'));
            // Safety check: Ensure length is a valid number larger than 1 byte
            if (length && length > 1) finalSize = length;
        } catch (e) {
            console.log("🌐 [Network] HEAD failed or timed out.");
        }

        // Phase 2: The 1-Byte Range Request
        if (!finalSize) {
            const watchdog = new FetchWatchdog(RANGE_FETCH_TIMEOUT_MS, null);
            try {
                const getRes = await fetch(this.source, {
                    headers: { 'Range': 'bytes=0-0' },
                    signal: watchdog.signal
                });
                const contentRange = getRes.headers.get('content-range');

                if (contentRange) {
                    const totalSize = contentRange.split('/')[1];
                    if (totalSize && totalSize !== '*') finalSize = parseInt(totalSize, 10);
                }

                if (getRes.body) await getRes.body.cancel().catch(() => { });
            } catch (e) {
                console.log("🌐 [Network] Range probe failed or timed out.");
            } finally {
                watchdog.dispose();
            }
        }

        // Phase 3: The Aborted GET (Ultimate CORS Failsafe)
        if (!finalSize) {
            console.log("🌐 [Network] Range hidden. Falling back to aborted GET.");
            const watchdog = new FetchWatchdog(RANGE_FETCH_TIMEOUT_MS, null);
            try {
                const getRes = await fetch(this.source, { signal: watchdog.signal });
                const length = parseInt(getRes.headers.get('content-length'));

                if (length && length > 1) finalSize = length;

                if (getRes.body) await getRes.body.cancel().catch(() => { });
                watchdog.controller.abort(); // we only wanted the headers — cut the body now that we have them
            } catch (e) { }
            finally {
                watchdog.dispose();
            }
        }

        // Apply size or fallback to blind mode
        if (finalSize) {
            this.size = finalSize;
            console.log(`✅ File size locked in at: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);
        } else {
            console.warn("⚠️ Could not fetch file size. Running in blind mode.");
            this.size = Infinity;
        }
        console.log(this.size);
    }

    // FINDS THE SEEK TABLE (skip indexes) FROM THE SeekID (table of contents)
    async read(start, end, signal) {
        const parts = [];
        let length = 0;
        for await (const part of this.stream(start, end, signal)) {
            parts.push(part);
            length += part.length;
        }
        if (parts.length === 1) return parts[0];
        const result = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
        return result;
    }

    async *stream(start, end, signal) {
        end = Math.min(end, this.size);
        if (start >= end) return;
        const watchdog = new FetchWatchdog(RANGE_FETCH_TIMEOUT_MS, signal);
        let reader;
        let completed = false;
        let received = 0;
        let response;
        try {
            let body;
            if (this.type === 'file') {
                body = this.source.slice(start, end).stream();
            } else {
                this.stats.rangeRequests++;
                this.stats.rangeBytesRequested += end - start;
                response = await fetch(this.source, {
                    headers: { Range: `bytes=${start}-${end - 1}` },
                    signal: watchdog.signal
                });
                const range = response.headers.get('content-range');
                if (response.status === 416) {
                    const match = /^bytes \*\/(\d+)$/.exec(range || '');
                    if (match) this.size = Number(match[1]);
                    if (Number.isFinite(this.size) && start >= this.size) return;
                    throw new Error('Range rejected; cannot establish end of file.');
                }
                if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
                if (response.status !== 206 && start !== 0)
                    throw new Error('Server ignored the byte Range request. Seeking requires HTTP 206.');
                const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range || '');
                if (match) {
                    if (Number(match[1]) !== start) throw new Error('Unexpected Content-Range offset.');
                    if (match[3] !== '*') this.size = Number(match[3]);
                } else if (response.status === 200) {
                    const length = Number(response.headers.get('content-length'));
                    if (length > 0) this.size = length;
                }
                end = Math.min(end, this.size);
                body = response.body;
            }
            if (!body) throw new Error('Response has no readable body.');
            reader = body.getReader();
            while (received < end - start) {
                if (watchdog.signal.aborted) throw watchdog.signal.reason;
                watchdog.bump();
                const { done, value } = await reader.read();
                // Slow decoding / disk writes are not network inactivity.
                watchdog.pause();
                if (done) {
                    completed = true;
                    if (received < end - start) {
                        if (response?.status === 200 && !Number.isFinite(this.size)) {
                            this.size = start + received;
                        } else {
                            throw new Error('Truncated range response.');
                        }
                    }
                    break;
                }
                this.stats.streamReads++;
                this.stats.streamBytesRead += value.length;
                const part = value.subarray(0, Math.min(value.length, end - start - received));
                if (part.length) {
                    received += part.length;
                    this.stats.streamBytesDelivered += part.length;
                    yield part;
                }
            }
        } finally {
            watchdog.dispose();
            if (reader) {
                if (response && received < end - start) this.stats.earlyRangeStops++;
                if (!completed) await reader.cancel().catch(() => {});
                reader.releaseLock();
            } else if (response?.body) {
                await response.body.cancel().catch(() => {});
            }
            watchdog.controller.abort();
        }
    }


}

function readVintJS(buffer, offset, maxOffset) {
    if (offset >= maxOffset) return null;

    const firstByte = buffer[offset];
    let length = 0;

    if (firstByte & 0x80) length = 1;
    else if (firstByte & 0x40) length = 2;
    else if (firstByte & 0x20) length = 3;
    else if (firstByte & 0x10) length = 4;
    else if (firstByte & 0x08) length = 5;
    else if (firstByte & 0x04) length = 6;
    else if (firstByte & 0x02) length = 7;
    else if (firstByte & 0x01) length = 8;
    else return null;

    if (offset + length > maxOffset) return null;

    let value = firstByte & (0xFF >> length);
    for (let i = 1; i < length; i++) {
        value = (value * 256) + buffer[offset + i];
    }
    return { value: value, length: length };
}

function patchSegmentToUnknown(buffer) {
    // Search for the main MKV Segment ID: 0x18 0x53 0x80 0x67
    for (let i = 0; i < buffer.length - 8; i++) {
        if (buffer[i] === 0x18 && buffer[i + 1] === 0x53 &&
            buffer[i + 2] === 0x80 && buffer[i + 3] === 0x67) {

            const vintOffset = i + 4;
            const vint = readVintJS(buffer, vintOffset, buffer.length);

            if (vint && vint.length > 0) {
                console.log(`🔨 [Patch] Found Segment at byte ${i}. Patching ${vint.length}-byte size to 'Unknown'...`);

                // An "Unknown" size in EBML is represented by setting all payload bits to 1.
                // This calculates the correct leading bits for the existing byte length:
                buffer[vintOffset] = 0xFF >> (vint.length - 1);

                // Fill all subsequent bytes of the size integer with 1s (0xFF)
                for (let j = 1; j < vint.length; j++) {
                    buffer[vintOffset + j] = 0xFF;
                }
            }
            return vint ? vintOffset + vint.length : null;
        }
    }
}

class Demuxer {
    // Allocate wasm memory to convert the js codec string
    constructor(videoId, audioId, width, height, duration, codecId) {
        if (wasm._demuxer_audio_timing_version?.() !== 1)
            throw new Error('Rebuild and deploy streaming-engine.js and streaming_engine.wasm together: incompatible audio timing API.');
        const encoder = new TextEncoder();
        const codecBytes = encoder.encode(codecId + "\0");
        const codecPtr = wasm._alloc_memory(codecBytes.length);
        new Uint8Array(getWasmMemory(), codecPtr, codecBytes.length).set(codecBytes);

        this.inputPtr = 0;
        this.inputCapacity = 0;
        this.ptr = wasm._demuxer_create(
            BigInt(videoId), BigInt(audioId),
            Number(width), Number(height),
            Number(duration), codecPtr
        );

        wasm._free_memory(codecPtr, codecBytes.length);
    }

    setTranscodeMode(needsTranscode) {
        wasm._demuxer_set_transcode_mode(this.ptr, needsTranscode);
    }

    _handleBufferResult(ptr) {
        if (ptr === 0) return new Uint8Array(0);
        const len = wasm._demuxer_get_last_len(this.ptr);
        try {
            return len ? new Uint8Array(getWasmMemory(), ptr, len).slice() : new Uint8Array(0);
        } finally {
            wasm._free_segment(ptr, len);
        }
    }

    _copyInput(data) {
        if (!this.inputPtr || data.length > this.inputCapacity) {
            const capacity = Math.max(1024 * 1024, data.length, this.inputCapacity * 2);
            const ptr = wasm._alloc_memory(capacity);
            if (!ptr) throw new Error('Unable to allocate Wasm input buffer.');
            if (this.inputPtr) wasm._free_memory(this.inputPtr, this.inputCapacity);
            this.inputPtr = ptr;
            this.inputCapacity = capacity;
        }
        // Any Wasm allocation may have grown memory; never retain a heap view.
        new Uint8Array(getWasmMemory(), this.inputPtr, data.length).set(data);
        return this.inputPtr;
    }

    init(chunkData) {
        const input = this._copyInput(chunkData);
        const ptr = wasm._demuxer_init(this.ptr, input, chunkData.length);
        if (!ptr) {
            const errorPtr = wasm._demuxer_get_last_error?.(this.ptr);
            const detail = errorPtr ? wasm.UTF8ToString(errorPtr) :
                'No diagnostic available; deploy the rebuilt engine JavaScript and Wasm together.';
            throw new Error(`Rust initialization failed: ${detail}`);
        }
        return this._handleBufferResult(ptr);
    }

    get_mp4_segment() {
        const ptr = wasm._demuxer_get_mp4_segment(this.ptr);
        return this._handleBufferResult(ptr);
    }

    should_emit_segment() {
        if (!wasm._demuxer_should_emit_segment)
            throw new Error('Rebuild and deploy streaming-engine.js and streaming_engine.wasm together: missing segment budget export.');
        return Boolean(wasm._demuxer_should_emit_segment(this.ptr,
            SEGMENT_VIDEO_FRAMES, SEGMENT_DURATION_MS, SEGMENT_MEDIA_BYTES));
    }

    get_mfra_box() {
        if (!wasm._demuxer_get_mfra_box) return new Uint8Array(0); // Safety check
        const ptr = wasm._demuxer_get_mfra_box(this.ptr);
        return this._handleBufferResult(ptr);
    }

    parse_chunk(chunkData, isFinal) {
        const ptr = this._copyInput(chunkData);
        const frames = wasm._demuxer_parse_chunk(this.ptr, ptr, chunkData.length, isFinal);
        this._checkParseError();
        return frames;
    }

    parse_chunk_direct(chunkPtr, chunkLength, isFinal) {
        // No alloc, no .set() copy, no free, just execute.
        const frames = wasm._demuxer_parse_chunk(this.ptr, chunkPtr, chunkLength, isFinal);
        this._checkParseError();
        return frames;
    }

    _checkParseError() {
        const errorPtr = wasm._demuxer_get_last_error(this.ptr);
        if (errorPtr) {
            const detail = wasm.UTF8ToString(errorPtr);
            const error = new Error(`Rust cluster parsing failed: ${detail}`);
            error.requiresAudioTranscode = detail.startsWith('Native audio trimming requires AAC conversion:');
            throw error;
        }
    }

    reset() { wasm._demuxer_reset(this.ptr); }
    destroy() {
        const ptr = this.ptr;
        const inputPtr = this.inputPtr;
        const inputCapacity = this.inputCapacity;
        this.ptr = this.inputPtr = this.inputCapacity = 0;
        try {
            if (ptr) wasm._demuxer_destroy(ptr);
        } finally {
            if (inputPtr) wasm._free_memory(inputPtr, inputCapacity);
        }
    }
}

//#region Core Engine
class CoreEngine {
    constructor() {
        liveEngineCount++;
        this._destroyPromise = null;
        this.video = null;
        this.chunkSize = 10 * 1024 * 1024;

        this._bufferQueue = Promise.resolve();
        this._streamPromise = null;
        this._audioGeneration = 0;
        this._aacPtr = this._aacCapacity = 0;
        this._pcmBuffer = new Float32Array(0);

        this.downloadBuffer = [];
        this.isRecording = false;
        this.mp4InitSegment = null;

        this._resetState();
    }

    log(msg) { console.log("Engine:", msg); }

    _resetState() {
        this.isFetching = false;
        if (this.abortController) this.abortController.abort();
        this.abortController = null;
        this.currentStreamId = (this.currentStreamId || 0) + 1;
        this.currentOffset = 0;
        this.cueMap = [];
        this.audioTracks = [];
        this.sourceBuffer = null;
        this._sourceBufferMime = null;
        this._forceTranscodeTracks = new Set();

        this.audioFramesIn = 0;
        this.audioFramesOut = 0;
        this._eof = false;
        this._streamError = null;
        this._lastEviction = 0;
        this._performanceStats = { parseCalls: 0, parsedBytes: 0, parseMs: 0,
            maxParseMs: 0, parseYields: 0, segments: 0, segmentBytes: 0, maxSegmentBytes: 0 };
    }

    getPerformanceStats() {
        return { ...this._performanceStats, network: { ...this.sourceInput?.stats } };
    }

    async _bootAudioEncoder(targetAudioTrack) {
        if (!targetAudioTrack) throw new Error('Missing audio track.');
        const generation = ++this._audioGeneration;
        const demuxer = this.demuxer;
        this._encoderError = null;
        this._audioPcmEndDts = null;
        if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
            try { this.audioEncoder.close(); } catch (e) { }
        }

        const currentSampleRate = Math.round(targetAudioTrack.sample_rate || 48000);
        const originalChannels = targetAudioTrack.channels;

        // 1. Build the Negotiation Queue based on your rules
        const configsToTry = [];

        // Only try 6 channels if the original file actually has 6 or more
        if (originalChannels >= 6) {
            configsToTry.push({ channels: 6, vbr: true, bitrate: 192000 }); // 1. 6-Ch VBR
            configsToTry.push({ channels: 6, vbr: false, bitrate: 192000 }); // 2. 6-Ch CBR
        }

        // Always queue Stereo as the smart fallback (or primary if source < 6)
        configsToTry.push({ channels: 2, vbr: true, bitrate: 128000 });  // 3. 2-Ch VBR
        configsToTry.push({ channels: 2, vbr: false, bitrate: 128000 }); // 4. 2-Ch CBR

        let finalConfig = null;
        let finalChannels = 2;

        // 2. Find an AAC configuration the browser accepts.
        for (const test of configsToTry) {
            const config = {
                codec: 'mp4a.40.2',
                sampleRate: currentSampleRate,
                numberOfChannels: test.channels,
                bitrate: test.bitrate,
                bitrateMode: test.vbr ? "variable" : "constant"
            };

            const support = await AudioEncoder.isConfigSupported(config);
            if (support.supported) {
                this.log(`Encoder supports ${test.channels} channels (${test.vbr ? 'VBR' : 'CBR'}).`);
                finalConfig = config;
                finalChannels = test.channels;
                break;
            }
        }

        if (!finalConfig) throw new Error('This browser has no supported AAC encoder configuration.');
        if (generation !== this._audioGeneration) return;

        this.encoderChannels = finalChannels;

        // 4. Beam the final decision down to Rust so it downmixes perfectly
        if (this.demuxer && this.demuxer.ptr) {
            wasm._demuxer_set_target_channels(this.demuxer.ptr, this.encoderChannels);
        }

        // Configure the browser audio encoder
        this.audioEncoder = new AudioEncoder({
            output: (chunk) => {
                if (generation !== this._audioGeneration || this.demuxer !== demuxer || !demuxer.ptr) return;
                try {
                    if (chunk.byteLength > this._aacCapacity) {
                        const capacity = Math.max(8192, chunk.byteLength, this._aacCapacity * 2);
                        const ptr = wasm._alloc_memory(capacity);
                        if (!ptr) throw new Error('Unable to allocate AAC staging buffer.');
                        if (this._aacPtr) wasm._free_memory(this._aacPtr, this._aacCapacity);
                        this._aacPtr = ptr;
                        this._aacCapacity = capacity;
                    }
                    chunk.copyTo(new Uint8Array(getWasmMemory(), this._aacPtr, chunk.byteLength));
                    const pts = Math.round(chunk.timestamp * currentSampleRate / 1000000);
                    const packetSamples = Math.round((chunk.duration ?? 1024 * 1000000 / currentSampleRate)
                        * currentSampleRate / 1000000);
                    const duration = Math.max(0, Math.min(packetSamples,
                        (this._audioPcmEndDts ?? pts + packetSamples) - pts));
                    // Retain negative priming timestamps; the MP4 writer gives
                    // them signed composition offsets instead of duplicate DTS=0.
                    if (duration) wasm._demuxer_append_aac(demuxer.ptr,
                        this._aacPtr, chunk.byteLength, BigInt(pts), duration);
                    this.audioFramesOut++;
                } catch (e) { this._encoderError = e; this._encoderWake?.(); }
            },
            error: (e) => { if (generation === this._audioGeneration) { this._encoderError = e; this._encoderWake?.(); } }
        });

        this.audioEncoder.configure(finalConfig);
        this.log(`Audio encoder configured for ${this.encoderChannels} channels.`);
    }

    attachVideo(videoElement) {
        this.video = videoElement;

        this.textTracks = {};
        if (this.subtitleTracks && this.subtitleTracks.length > 0) {
            this.subtitleTracks.forEach((track, index) => {

                // Format as "(Name) eng" if a name exists, otherwise just "eng"
                const trackLabel = track.name
                    ? `[${track.name}] ${track.language}`
                    : track.language;

                const t = this.video.addTextTrack("subtitles", trackLabel, track.language);
                t.mode = (index === 0) ? "showing" : "hidden";

                this.textTracks[track.track_number] = {
                    htmlTrack: t,
                    codec: track.codec_id
                };
            });
        }

        this.video.disableRemotePlayback = true;
        this.video.onseeking = () => this._onSeeking();
        this.video.ontimeupdate = () => this._onTimeUpdate();

        this.video.onwaiting = () => { this._alignStartupPosition(); this._streamLoop(); };
        this.video.onstalled = () => { this._alignStartupPosition(); this._streamLoop(); };
        this.video.onerror = () => this._onPlaybackError();
        this._onlineHandler = () => this._streamLoop();
        window.addEventListener('online', this._onlineHandler);

        this._objectURL = URL.createObjectURL(this.mediaSource);
        this.video.src = this._objectURL;
        this.log("Video tag attached. Stream routed to screen.");
    }

    async preload(fetcher) {
        this._resetState();
        this.sourceInput = fetcher;

        this.log("Probing for MKV clusters...");

        const maxProbe = 100 * 1024 * 1024;
        let capacity = 2 * 1024 * 1024;

        await ensureWasm();
        let ptr = wasm._alloc_memory(capacity);
        try {
        let memBuffer = getWasmMemory();
        let wasmHeap = new Uint8Array(memBuffer, ptr, capacity);

        let currentSize = 0;
        let absoluteFileOffset = 0;
        let clusterFound = false;
        let firstClusterIndex = 0; // The clean slice marker


        while (!clusterFound && absoluteFileOffset < this.sourceInput.size && currentSize < maxProbe) {
            const probeController = new AbortController();
            let jumped = false;

            // 1. Calculate a bounded end to stop ghost connections
            const probeEnd = Math.min(absoluteFileOffset + capacity, this.sourceInput.size);

            try {
                // 2. Request only up to probeEnd instead of this.sourceInput.size
                for await (const chunk of this.sourceInput.stream(absoluteFileOffset, probeEnd, probeController.signal)) {


                    if (currentSize + chunk.length > capacity) {
                        let oldPtr = ptr;
                        let oldCapacity = capacity;
                        capacity = Math.max(capacity * 2, currentSize + chunk.length);
                        ptr = wasm._alloc_memory(capacity);
                        let freshBuffer = getWasmMemory();
                        let oldView = new Uint8Array(freshBuffer, oldPtr, currentSize);
                        let newWasmHeap = new Uint8Array(freshBuffer, ptr, capacity);
                        newWasmHeap.set(oldView);
                        wasm._free_memory(oldPtr, oldCapacity);
                        wasmHeap = newWasmHeap;
                    } else if (wasmHeap.buffer.byteLength === 0) {
                        wasmHeap = new Uint8Array(getWasmMemory(), ptr, capacity);
                    }

                    wasmHeap.set(chunk, currentSize);

                    let scanStart = Math.max(0, currentSize - 8);
                    currentSize += chunk.length;
                    absoluteFileOffset += chunk.length;

                    for (let i = scanStart; i < currentSize - 4; i++) {
                        if (wasmHeap[i] === 0x1F && wasmHeap[i + 1] === 0x43 &&
                            wasmHeap[i + 2] === 0xB6 && wasmHeap[i + 3] === 0x75) {
                            console.log(`[Probe] CLUSTER FOUND at absolute offset: ${absoluteFileOffset - currentSize + i}`); // ADD THIS

                            clusterFound = true;
                            this.firstClusterOffset = absoluteFileOffset - currentSize + i;
                            firstClusterIndex = i; // Save exact byte where headers end

                            probeController.abort();
                            break;
                        }

                        if (wasmHeap[i] === 0x19 && wasmHeap[i + 1] === 0x41 &&
                            wasmHeap[i + 2] === 0xA4 && wasmHeap[i + 3] === 0x69) {

                            const vint = readVintJS(wasmHeap, i + 4, currentSize);
                            if (vint) {
                                if (vint.value < 1024 * 1024) continue;

                                const skipAmount = 4 + vint.length + vint.value;
                                this.log(`Attachments skipped! Size: ${(vint.value / 1024 / 1024).toFixed(2)} MB.`);

                                const startOfBufferOffset = absoluteFileOffset - currentSize;
                                absoluteFileOffset = startOfBufferOffset + i + skipAmount;
                                currentSize = i;

                                jumped = true;
                                probeController.abort();
                                break;
                            }
                        }
                    }

                    if (clusterFound || jumped) break;
                    if (currentSize >= maxProbe) break;
                }
            } catch (err) {
                if (err?.name !== 'AbortError') throw err;
            }
            if (clusterFound) break;
        }

        if (!clusterFound) throw new Error("Could not find Video Track.");

        this.segmentPayloadStart = patchSegmentToUnknown(wasmHeap.subarray(0, currentSize));
        if (this.segmentPayloadStart == null) throw new Error("Missing MKV Segment header.");

        this.initialHeaderData = wasmHeap.slice(0, firstClusterIndex);

        let jsonPtr = wasm._get_mkv_info_fast_json(ptr, currentSize);

        const jsonStr = wasm.UTF8ToString(jsonPtr);

        this.mkvHeader = JSON.parse(jsonStr);
        wasm._free_string(jsonPtr);
        wasm._free_memory(ptr, capacity);
        ptr = 0;

        const videoTrack = (this.mkvHeader.tracks && this.mkvHeader.tracks.length > 0)
            ? this.mkvHeader.tracks.find(t => t.track_type === "video")
            : null;

        if (!videoTrack) {
            console.error(" [Debug] FATAL: Rust failed to find a video track! The MKV headers might be corrupted from the attachment jump.");
            return;
        }

        if (videoTrack.codec_id !== "V_MPEG4/ISO/AVC" && videoTrack.codec_id !== "V_MPEGH/ISO/HEVC") {
            this.log(`Critical: Unsupported video codec ${videoTrack.codec_id}`);
            alert(`Sorry, only H.264 and HEVC (H.265) video tracks are supported!`);
            throw new Error("Unsupported video codec.");
        }

        this.audioTracks = this.mkvHeader.tracks.filter(t => t.track_type === "audio");
        const { track: audioTrack, canPlayNatively } = await this._selectInitialAudioTrack(videoTrack);

        if (videoTrack.codec_id !== "V_MPEG4/ISO/AVC" && videoTrack.codec_id !== "V_MPEGH/ISO/HEVC") {
            this.log(`Critical: Unsupported video codec ${videoTrack.codec_id}`);
            alert(`Sorry, only H.264 and HEVC (H.265) video tracks are supported!`);
            throw new Error("Unsupported video codec.");
        }

        if (this.mkvHeader.cues_position) {
            const pos = this.segmentPayloadStart + Number(this.mkvHeader.cues_position);

            // 1. Fetch just the first 12 bytes of the Cues element to read its size header
            const headerBytes = await this.sourceInput.read(pos, pos + 12, null);

            // 2. Verify it's actually the Cues ID (0x1C53BB6B)
            let totalCuesSize = 0;
            if (headerBytes.length >= 5 && headerBytes[0] === 0x1C && headerBytes[1] === 0x53 &&
                headerBytes[2] === 0xBB && headerBytes[3] === 0x6B) {

                // 3. Calculate the exact payload size using your existing VINT reader
                const vint = readVintJS(headerBytes, 4, headerBytes.length);
                if (vint) {
                    totalCuesSize = 4 + vint.length + vint.value;
                }
            }

            // 4. Fetch the exact size, with a 5MB fallback just in case the file is corrupted
            const endPos = totalCuesSize > 0
                ? pos + totalCuesSize
                : Math.min(pos + (5 * 1024 * 1024), this.sourceInput.size);

            const cuesData = await this.sourceInput.read(pos, endPos, null);

            const cPtr = wasm._alloc_memory(cuesData.length);
            new Uint8Array(getWasmMemory(), cPtr, cuesData.length).set(cuesData);

            let cJsonPtr = wasm._parse_cues_json(cPtr, cuesData.length);
            this.cueMap = JSON.parse(wasm.UTF8ToString(cJsonPtr));
            const scale = (this.mkvHeader.timestamp_scale || 1000000) / 1000000;
            for (const cue of this.cueMap) cue.time *= scale;
            this.cueMap.sort((a, b) => a.time - b.time);

            wasm._free_string(cJsonPtr);
            wasm._free_memory(cPtr, cuesData.length);
        }

        const audioId = audioTrack ? BigInt(audioTrack.track_number) : 0n;
        this.demuxer = new Demuxer(
            BigInt(videoTrack.track_number), audioId,
            videoTrack.width, videoTrack.height,
            this.mkvHeader.duration * 1000, videoTrack.codec_id
        );

        // Find all text tracks that are SRT
        console.log("🕵️ Raw MKV Tracks from Rust:", this.mkvHeader.tracks);

        // 1. Expand the filter to catch SRT, ASS, and SSA
        const supportedSubCodecs = ["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA"];

        this.subtitleTracks = this.mkvHeader.tracks.filter(t =>
            t.track_type === "subtitle" && supportedSubCodecs.includes(t.codec_id)
        );

        wasm._demuxer_clear_subtitle_tracks(this.demuxer.ptr);
        this.subtitleTracks.forEach(track => {
            wasm._demuxer_add_subtitle_track(this.demuxer.ptr, BigInt(track.track_number));
            console.log(`✅ Subtitle Track #${track.track_number} (${track.codec_id}) sent to Rust parser.`);
        });

        if (videoTrack && audioTrack) {
            await this._configureAudioPipeline(videoTrack, audioTrack, canPlayNatively);
        }

        this.videoTrack = videoTrack;
        this.audioTrack = audioTrack;

        this.mediaSource = new MSE();
        this._sourceOpenHandler = () => this._onSourceOpen();
        this.mediaSource.addEventListener('sourceopen', this._sourceOpenHandler);
        } finally { if (ptr) wasm._free_memory(ptr, capacity); }
    }

    _getOptimalChunkBoundary(startOffset, bufferedAheadSeconds) {
        // 1. If the user is saving to disk, sprint at maximum speed
        if (this.isRecording) {
            let targetEnd = startOffset + (30 * 1024 * 1024);
            return Math.min(targetEnd, this.sourceInput.size);
        }

        // 2. Playback mode: Smoother, smaller bursts
        let targetSize = 2 * 1024 * 1024; // Startup/Seek: 2MB for fast response
        if (bufferedAheadSeconds > 3) targetSize = 6 * 1024 * 1024;  // Normal: 6MB
        if (bufferedAheadSeconds > 10) targetSize = 9 * 1024 * 1024; // Coasting: 9MB cap

        let targetEnd = startOffset + targetSize;
        // Incremental EBML parsing handles split elements. Snapping to sparse
        // cues could expand a small request all the way to the end of the file.
        return Math.min(targetEnd, this.sourceInput.size);
    }

    async _canPlayAudioNatively(videoTrack, audioTrack) {
        if (this._forceTranscodeTracks.has(audioTrack?.track_number)) return false;
        if (!audioTrack?.native_mp4) return false;
        const combinedMime = `video/mp4; codecs="${videoTrack.codec_string}, ${audioTrack.codec_string}"`;
        if (!isMseTypeSupported(combinedMime)) return false;
        // MSE checks the combined MP4 codec string. An audio-only capabilities
        // query can reject Opus even when that combined SourceBuffer is supported.
        // An explicit audio decoder error can still trigger an AAC retry.
        if (audioTrack.codec_id !== 'A_OPUS' && navigator.mediaCapabilities?.decodingInfo) {
            try {
                const info = await navigator.mediaCapabilities.decodingInfo({
                    type: 'media-source',
                    audio: {
                        contentType: `audio/mp4; codecs="${audioTrack.codec_string}"`,
                        channels: String(audioTrack.channels || 2),
                        samplerate: Math.round(audioTrack.sample_rate || 48000)
                    }
                });
                return Boolean(info.supported);
            } catch (e) { /* MSE's combined type check remains the fallback. */ }
        }
        return true;
    }

    async _selectInitialAudioTrack(videoTrack) {
        const first = this.audioTracks[0] || null;
        for (const track of this.audioTracks) {
            if (await this._canPlayAudioNatively(videoTrack, track))
                return { track, canPlayNatively: true };
        }
        return { track: first, canPlayNatively: false };
    }

    async _configureAudioPipeline(videoTrack, audioTrack, nativeSupport = null) {
        this._audioFallbackAttempted = false;
        if (!audioTrack) {
            this.needsAudioTranscode = false;
            if (this.demuxer) this.demuxer.setTranscodeMode(false);
            return;
        }

        const canPlayNatively = nativeSupport ?? await this._canPlayAudioNatively(videoTrack, audioTrack);

        if (canPlayNatively) {
            this.log(`Native MP4 audio selected for ${audioTrack.codec_id}; bypassing AAC conversion.`);

            this.needsAudioTranscode = false;
            if (this.demuxer) this.demuxer.setTranscodeMode(false);

            // Close the browser encoder if it was running.
            if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
                try { this.audioEncoder.close(); } catch (e) { }
            }
            this.audioEncoder = null;
            if (this._aacPtr) wasm._free_memory(this._aacPtr, this._aacCapacity);
            this._aacPtr = this._aacCapacity = 0;
        } else {
            this.log(`Routing to Transcoder: ${audioTrack.codec_id}`);

            this.needsAudioTranscode = true;
            if (this.demuxer) this.demuxer.setTranscodeMode(true);

            // Pass the explicitly provided track to the bootloader!
            await this._bootAudioEncoder(audioTrack);
        }
    }

    _outputMime() {
        const codecs = [this.videoTrack.codec_string];
        if (this.audioTrack) codecs.push(this.needsAudioTranscode ? 'mp4a.40.2' : this.audioTrack.codec_string);
        return `video/mp4; codecs="${codecs.join(', ')}"`;
    }

    async _updateSourceBufferType() {
        const mime = this._outputMime();
        if (mime === this._sourceBufferMime) return;
        await this._queueBufferOperation(buffer => {
            let changed = false;
            if (typeof buffer.changeType === 'function') {
                try { buffer.changeType(mime); changed = true; }
                catch (error) { if (error?.name !== 'NotSupportedError') throw error; }
            }
            if (!changed) {
                // Older MSE implementations need a fresh buffer for a new codec.
                this.mediaSource.removeSourceBuffer(buffer);
                this.sourceBuffer = null;
                this._sourceBufferMime = null;
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                this.sourceBuffer.mode = 'segments';
            }
            this._sourceBufferMime = mime;
        });
    }

    _audioSeekOffset(time) {
        // Opus needs decoder warm-up on every random access, including a switch
        // into an Opus track. FLAC has no inherent preroll; honor track metadata.
        const track = this.audioTrack;
        const preroll = Math.max(Number(track?.seek_pre_roll_ns || 0),
            Number(track?.codec_delay_ns || 0), track?.codec_id === 'A_OPUS' ? 80000000 : 0) / 1e9;
        const startTime = Math.max(0, time - preroll);
        if (!this.cueMap.length || startTime < this.cueMap[0].time) return this.firstClusterOffset;
        return this.segmentPayloadStart + Number(this._cueAtTime(startTime).offset);
    }

    _onPlaybackError() {
        if (this._retryingAudio || this._destroying) return;
        const mediaError = this.video?.error;
        const diagnostic = mediaError?.message || '';
        const error = new Error(`Media playback failed${mediaError ? ` (code ${mediaError.code})` : ''}${diagnostic ? `: ${diagnostic}` : '.'}`);
        const audioDecoderFailure = (mediaError?.code === 3 || mediaError?.code === 4) &&
            /\baudio\b/i.test(diagnostic) && !/\bvideo\b/i.test(diagnostic);
        if (audioDecoderFailure && this.audioTrack && !this.needsAudioTranscode && !this._audioFallbackAttempted) {
            this._retryAudioAsAac(error).catch(failure => {
                this._streamError = failure;
                console.error('AAC retry failed:', failure);
            });
        } else if (!this._destroying) {
            this._streamError = error;
            console.error('Playback failed:', error);
        }
    }

    async _retryAudioAsAac(reason) {
        if (this._audioFallbackAttempted || this._destroying) return;
        this._audioFallbackAttempted = true;
        this._forceTranscodeTracks.add(this.audioTrack?.track_number);
        this._retryingAudio = true;
        this.log(`Native MP4 audio rejected (${reason.message}); retrying with AAC.`);
        const video = this.video;
        try {
            const resumeTime = video?.currentTime || 0;
            const resumePlayback = video && !video.paused;
            await this._stopStream();
            if (this.sourceBuffer?.updating) {
                try { this.sourceBuffer.abort(); } catch (e) { }
            }
            await this._bufferQueue;
            if (this._destroying) return;

            this._clearSubtitleCues();

            if (this.mediaSource && this._sourceOpenHandler)
                this.mediaSource.removeEventListener('sourceopen', this._sourceOpenHandler);
            if (this.mediaSource?.readyState === 'open' && this.sourceBuffer) {
                try { this.mediaSource.removeSourceBuffer(this.sourceBuffer); } catch (e) { }
            }
            this.sourceBuffer = null;
            this._sourceBufferMime = null;
            video.onerror = null;
            video.pause();
            video.removeAttribute('src');
            video.load();
            if (this._objectURL) URL.revokeObjectURL(this._objectURL);
            this._objectURL = null;

            this.demuxer?.destroy();
            this.demuxer = this._createDemuxer(this.audioTrack);
            this.needsAudioTranscode = true;
            this.demuxer.setTranscodeMode(true);
            await this._bootAudioEncoder(this.audioTrack);
            if (this._destroying) return;
            this._needsPlaybackReset = false;
            this.currentOffset = this.firstClusterOffset || 0;
            this._sourceStartTime = resumeTime;
            this._eof = false;
            this._streamError = null;
            this.mediaSource = new MSE();
            this._sourceOpenHandler = () => this._onSourceOpen();
            this.mediaSource.addEventListener('sourceopen', this._sourceOpenHandler);
            this._objectURL = URL.createObjectURL(this.mediaSource);
            if (resumeTime > 0) {
                this._audioResumeHandler = () => {
                    this._audioResumeHandler = null;
                    video.currentTime = resumeTime;
                };
                video.addEventListener('loadedmetadata', this._audioResumeHandler, { once: true });
            }
            video.src = this._objectURL;
            if (resumePlayback) video.play().catch(() => {});
        } finally {
            if (video && !this._destroying) video.onerror = () => this._onPlaybackError();
            this._retryingAudio = false;
        }
    }

    _createDemuxer(audioTrack) {
        const demuxer = new Demuxer(
            BigInt(this.videoTrack.track_number), audioTrack ? BigInt(audioTrack.track_number) : 0n,
            this.videoTrack.width, this.videoTrack.height,
            this.mkvHeader.duration * 1000, this.videoTrack.codec_id
        );
        for (const subtitle of this.subtitleTracks || [])
            wasm._demuxer_add_subtitle_track(demuxer.ptr, BigInt(subtitle.track_number));
        return demuxer;
    }

    async _onSourceOpen() {
        if (this.sourceBuffer || this._destroying) return;
        const source = this.mediaSource;
        const id = this.currentStreamId;
        const startTime = this._sourceStartTime || 0;
        this._sourceStartTime = 0;
        let nativeAudioTypeRejected = false;
        try {
            const mime = this._outputMime();

            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                this._sourceBufferMime = mime;
            } catch (error) {
                if (error?.name === 'NotSupportedError' && this.audioTrack && !this.needsAudioTranscode) {
                    const videoCodec = this.videoTrack.codec_string;
                    nativeAudioTypeRejected = isMseTypeSupported(`video/mp4; codecs="${videoCodec}"`) &&
                        isMseTypeSupported(`video/mp4; codecs="${videoCodec}, mp4a.40.2"`);
                }
                throw error;
            }
            this.sourceBuffer.mode = 'segments';
            this.mediaSource.duration = this.mkvHeader.duration;


            const initData = this.demuxer.init(this.initialHeaderData);

            this.mp4InitSegment = initData;

            if (!initData || initData.length < 100) throw new Error("Invalid Init Segment from Rust");
            await this._appendToBuffer(initData);
            if (this._destroying || source !== this.mediaSource || id !== this.currentStreamId) return;

            this.currentOffset = this._audioSeekOffset(startTime);
            this.log("▶️ Stream routed to screen. Buffering clusters...");
            this._streamLoop();

        } catch (error) {
            if (source !== this.mediaSource || this._retryingAudio || this._destroying) return;
            if (nativeAudioTypeRejected && !this._audioFallbackAttempted) {
                this._retryAudioAsAac(error).catch(failure => {
                    this._streamError = failure;
                    console.error('AAC retry failed:', failure);
                });
                return;
            }
            this._streamError = error;
            console.error("Engine Crash in _onSourceOpen:", error);
        }
    }

    _bufferedAhead() {
        const time = this.video?.currentTime || 0;
        const ranges = this.sourceBuffer?.buffered;
        if (!ranges) return 0;
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.start(i) <= time + 0.05 && ranges.end(i) > time)
                return ranges.end(i) - time;
        }
        return 0;
    }

    _alignStartupPosition() {
        const video = this.video;
        if (!video || video.currentTime > 1 || this.isSeeking || this._destroying) return false;
        const videoRanges = video.buffered;
        const ranges = videoRanges?.length ? videoRanges : this.sourceBuffer?.buffered;
        if (!ranges?.length) return false;
        // Opus pre-skip can put the first playable sample after time zero.
        const start = ranges.start(0);
        if (start > video.currentTime + 0.001 && ranges.end(0) > start + 0.001) {
            video.currentTime = start + 0.001;
            return true;
        }
        return false;
    }

    async _stopStream() {
        ++this.currentStreamId;
        this.abortController?.abort();
        await this._streamPromise;
        this.isFetching = false;
        this._eof = false;
        this._streamError = null;
    }

    _streamLoop() {
        if (this._streamPromise) return this._streamPromise;
        if (this._destroying || this.isSeeking || this._eof || this._streamError ||
            !this.sourceBuffer || !this.sourceInput || this.mediaSource?.readyState === 'closed')
            return Promise.resolve();
        if (!this.isRecording && this.currentOffset < this.sourceInput.size &&
            this._bufferedAhead() > STREAM_BUFFER_RESUME_SECONDS)
            return Promise.resolve();
        const id = this.currentStreamId;
        this.isFetching = true;
        this._streamPromise = this._runStream(id).catch(error => {
            if (id === this.currentStreamId && error?.name !== 'AbortError') {
                if (error.requiresAudioTranscode && !this.needsAudioTranscode &&
                    !this.isRecording && !this._audioFallbackAttempted) {
                    // Do not await here: the retry first waits for this stream
                    // promise to settle before destroying its demuxer.
                    this._retryAudioAsAac(error).catch(failure => {
                        this._streamError = failure;
                        console.error('AAC retry failed:', failure);
                    });
                    return;
                }
                this._streamError = error;
                console.error('Stream error:', error);
            }
        }).finally(() => {
            this._streamPromise = null;
            this.isFetching = false;
        });
        return this._streamPromise;
    }

    async _runStream(id) {
        let bytesSinceYield = 0;
        let parseMsSinceYield = 0;
        let lastProgress = -1;
        while (id === this.currentStreamId) {
            if (this.currentOffset >= this.sourceInput.size) {
                await this._completeInput(id);
                return;
            }
            const ahead = this._bufferedAhead();
            if (!this.isRecording && ahead >= STREAM_BUFFER_TARGET_SECONDS) return;
            const start = this.currentOffset;
            const end = Math.min(this._getOptimalChunkBoundary(start, ahead), this.sourceInput.size);
            if (!(end > start)) throw new Error('Input range made no progress.');
            const controller = new AbortController();
            this.abortController = controller;
            let received = 0;
            try {
                for await (const chunk of this.sourceInput.stream(start, end, controller.signal)) {
                    for (let offset = 0; offset < chunk.length; offset += PARSE_SLICE_BYTES) {
                        if (id !== this.currentStreamId) return;
                        if (controller.signal.aborted) throw controller.signal.reason;
                        const slice = chunk.subarray(offset, offset + PARSE_SLICE_BYTES);
                        const nextOffset = this.currentOffset + slice.length;
                        const parseStart = performance.now();
                        this.demuxer.parse_chunk(slice, nextOffset >= this.sourceInput.size);
                        const elapsed = performance.now() - parseStart;
                        // Commit only accepted bytes, before any await. An unread
                        // tail of this reader chunk is fetched again after a pause.
                        this.currentOffset = nextOffset;
                        received += slice.length;
                        bytesSinceYield += slice.length;
                        parseMsSinceYield += elapsed;
                        const stats = this._performanceStats;
                        stats.parseCalls++;
                        stats.parsedBytes += slice.length;
                        stats.parseMs += elapsed;
                        stats.maxParseMs = Math.max(stats.maxParseMs, elapsed);
                        this._pullSubtitles();
                        if (this.needsAudioTranscode) await this._drainAudio(id, controller.signal);
                        if (id !== this.currentStreamId) return;
                        if (this.demuxer.should_emit_segment()) {
                            await this._emitSegment(id);
                            if (id !== this.currentStreamId) return;
                            if (!this.isRecording && this._bufferedAhead() >= STREAM_BUFFER_TARGET_SECONDS) return;
                        }
                        if (this.isRecording && this.onDownloadProgress && Number.isFinite(this.sourceInput.size)) {
                            const progress = Math.min(99, Math.floor(this.currentOffset / this.sourceInput.size * 100));
                            if (progress !== lastProgress) {
                                lastProgress = progress;
                                this.onDownloadProgress(progress);
                            }
                        }
                        if (bytesSinceYield >= PARSE_YIELD_BYTES || parseMsSinceYield >= PARSE_YIELD_MS) {
                            stats.parseYields++;
                            await yieldThread();
                            if (id !== this.currentStreamId) return;
                            bytesSinceYield = 0;
                            parseMsSinceYield = 0;
                        }
                    }
                }
            } finally {
                if (this.abortController === controller) this.abortController = null;
            }
            if (id !== this.currentStreamId) return;
            if (this.currentOffset >= this.sourceInput.size) {
                await this._completeInput(id);
                return;
            }
            if (!received) throw new Error('Empty range response before a confirmed end of file.');
        }
    }

    _clearSubtitleCues() {
        // Keep the TextTracks and their selected modes, but discard cues from
        // the old parsing pass before the restarted demuxer adds them again.
        for (const { htmlTrack } of Object.values(this.textTracks || {})) {
            while (htmlTrack.cues?.length)
                htmlTrack.removeCue(htmlTrack.cues[htmlTrack.cues.length - 1]);
        }
    }

    _pullSubtitles() {
        if (this.subtitleTracks && this.subtitleTracks.length > 0) {
            // Ask Rust if there are any subtitles waiting (Fast C++ call)
            const pendingCues = wasm._demuxer_get_subtitle_count(this.demuxer.ptr);

            if (pendingCues > 0) {
                // Pull the JSON string from Rust
                const subJsonPtr = wasm._demuxer_pull_subtitles_json(this.demuxer.ptr);
                const subJsonStr = wasm.UTF8ToString(subJsonPtr);
                wasm._free_string(subJsonPtr); // Free the memory!

                const cues = JSON.parse(subJsonStr);

                for (let cueData of cues) {
                    const trackObj = this.textTracks[cueData.track_id];
                    if (trackObj && cueData.duration_ms > 0) {
                        // Convert milliseconds to seconds for the browser
                        const startTime = cueData.start_ms / 1000;
                        const endTime = startTime + (cueData.duration_ms / 1000);
                        const cleanText = cleanSubtitleText(trackObj.codec, cueData.text);

                        try {
                            // Create the native subtitle cue and inject it!
                            const cue = new VTTCue(startTime, endTime, cleanText);
                            trackObj.htmlTrack.addCue(cue);
                        } catch (e) { } // Ignore overlapping cue errors
                    }
                }
            }
        }

    }

    _waitEncoder(encoder, signal) {
        if (this._encoderError) return Promise.reject(this._encoderError);
        if (encoder.encodeQueueSize < 16) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                encoder.removeEventListener('dequeue', check);
                signal?.removeEventListener('abort', abort);
                clearTimeout(timer);
                if (this._encoderWake === check) this._encoderWake = null;
            };
            const abort = () => { cleanup(); reject(signal.reason || new DOMException('Stopped', 'AbortError')); };
            const check = () => {
                if (signal?.aborted) return abort();
                if (this._encoderError || encoder.state !== 'configured') {
                    cleanup(); reject(this._encoderError || new Error('Audio encoder closed.'));
                } else if (encoder.encodeQueueSize <= 8) { cleanup(); resolve(); }
            };
            const timer = setTimeout(() => { cleanup(); reject(new Error('Audio encoder stalled.')); }, 15000);
            encoder.addEventListener('dequeue', check);
            signal?.addEventListener('abort', abort, { once: true });
            this._encoderWake = check;
            check();
        });
    }

    _encodePCM(samples, encoder) {
        const channels = this.encoderChannels;
        const sampleRate = Math.round(this.audioTrack.sample_rate || 48000);
        const total = samples * channels;
        if (this._pcmBuffer.length < total) this._pcmBuffer = new Float32Array(total);
        const ptr = wasm._get_audio_ptr();
        const memory = getWasmMemory();
        for (let channel = 0; channel < channels; channel++) {
            this._pcmBuffer.set(new Float32Array(memory, ptr + channel * 192000 * 4, samples), channel * samples);
        }
        const dts = BigInt(wasm._demuxer_get_last_audio_dts(this.demuxer.ptr));
        // Without a transfer list AudioData snapshots the supplied samples.
        const data = new AudioData({ format: 'f32-planar', sampleRate,
            numberOfChannels: channels, numberOfFrames: samples,
            timestamp: Number(dts * 1000000n / BigInt(sampleRate)),
            data: this._pcmBuffer.subarray(0, total) });
        this._audioPcmEndDts = Math.max(this._audioPcmEndDts ?? 0, Number(dts) + samples);
        try { encoder.encode(data); this.audioFramesIn++; }
        finally { data.close(); }
    }

    async _drainAudio(id, signal, final = false) {
        if (!this.needsAudioTranscode || !this.audioTrack) return;
        const encoder = this.audioEncoder;
        if (!encoder || encoder.state !== 'configured') throw new Error('Audio encoder is not configured.');
        let deadline = performance.now() + 4;
        let flushing = false;
        while (id === this.currentStreamId) {
            if (this._encoderError) throw this._encoderError;
            if (encoder.encodeQueueSize >= 16) await this._waitEncoder(encoder, signal);
            if (id !== this.currentStreamId) return;
            const samples = flushing ? wasm._demuxer_flush_audio(this.demuxer.ptr)
                : wasm._demuxer_decode_next_audio_frame(this.demuxer.ptr);
            if (samples < 0) throw new Error(`Audio decoder failed (${samples}).`);
            if (!samples) {
                if (final && !flushing) { flushing = true; continue; }
                break;
            }
            this._encodePCM(samples, encoder);
            if (performance.now() >= deadline) { await yieldThread(); deadline = performance.now() + 4; }
        }
        if (final && id === this.currentStreamId) {
            await encoder.flush();
            if (this._encoderError) throw this._encoderError;
        }
    }

    async _emitSegment(id) {
        if (id !== this.currentStreamId) return;
        const segment = this.demuxer.get_mp4_segment();
        if (!segment.length) return;
        this._performanceStats.segments++;
        this._performanceStats.segmentBytes += segment.length;
        this._performanceStats.maxSegmentBytes = Math.max(this._performanceStats.maxSegmentBytes, segment.length);
        if (this.isRecording && this.diskStream) await this.diskStream.write(segment);
        else {
            await this._appendToBuffer(segment, id);
            if (id === this.currentStreamId) {
                const aligned = this._alignStartupPosition();
                if (this.video?.paused && (aligned || this.video.currentTime === 0))
                    this.video.play().catch(() => {});
            }
        }
    }

    async _completeInput(id) {
        if (id !== this.currentStreamId || this._eof) return;
        // Also handles EOF learned from response headers after the last chunk.
        this.demuxer.parse_chunk(new Uint8Array(0), true);
        this._pullSubtitles();
        await this._drainAudio(id, undefined, true);
        if (id !== this.currentStreamId) return;
        await this._emitSegment(id);
        if (id !== this.currentStreamId) return;
        this._eof = true;
        if (this.isRecording) this.onDownloadProgress?.(100);
        else await this._queueBufferOperation(() => {
            if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
        }, id);
    }

    _onTimeUpdate() {
        if (!this.sourceBuffer || !this.video || this.mediaSource.readyState !== 'open') return;

        this._runGarbageCollector();
        this._streamLoop();
    }

    async _onSeeking(force = false) {
        if (this.isSeeking || this._destroying || this.isRecording || !this.video ||
            !this.cueMap?.length || this.mediaSource?.readyState === 'closed') return;
        if (!force && this._bufferedAhead() > 0) return;
        this.isSeeking = true;
        try {
            await this._stopStream();
            const id = this.currentStreamId;
            await this._queueBufferOperation(buffer => {
                if (buffer.buffered.length) buffer.remove(0, this.mediaSource.duration);
            }, id);
            this._clearSubtitleCues();
            this.currentOffset = this._audioSeekOffset(this.video.currentTime);
            this.demuxer.reset();
            this._lastEviction = 0;
            if (this.needsAudioTranscode) await this._bootAudioEncoder(this.audioTrack);
        } catch (error) {
            this._streamError = error;
            console.error('Seek failed:', error);
        } finally { this.isSeeking = false; }
        this._streamLoop();
    }

    _cueAtTime(time) {
        let low = 0, high = this.cueMap.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.cueMap[mid].time <= time) low = mid + 1;
            else high = mid;
        }
        return this.cueMap[Math.max(0, low - 1)];
    }

    async switchAudioTrack(newTrackNumber) {
        const track = this.audioTracks.find(t => t.track_number === Number(newTrackNumber));
        if (!track || track === this.audioTrack || !this.video || this.isSeeking || this.isRecording || this._destroying || this._retryingAudio) return;
        const time = this.video.currentTime;
        const resume = !this.video.paused;
        this.video.pause();
        this.isSeeking = true;
        try {
            await this._stopStream();
            if (this._destroying) return;
            const id = this.currentStreamId;
            ++this._audioGeneration;
            if (this.audioEncoder?.state !== 'closed') this.audioEncoder?.close();
            this.audioEncoder = null;
            await this._queueBufferOperation(buffer => {
                if (buffer.buffered.length) buffer.remove(0, this.mediaSource.duration);
            });
            if (this._destroying || id !== this.currentStreamId) return;
            this._clearSubtitleCues();
            this.demuxer.destroy();
            this.audioTrack = track;
            this.demuxer = this._createDemuxer(track);
            await this._configureAudioPipeline(this.videoTrack, track);
            if (this._destroying || id !== this.currentStreamId) return;
            this.mp4InitSegment = this.demuxer.init(this.initialHeaderData);
            if (!this.mp4InitSegment.length) throw new Error('Audio track initialization failed.');
            await this._updateSourceBufferType();
            if (this._destroying || id !== this.currentStreamId) return;
            await this._appendToBuffer(this.mp4InitSegment);
            if (this._destroying || id !== this.currentStreamId) return;
            this.currentOffset = this._audioSeekOffset(time);
            this._lastEviction = 0;
        } catch (error) {
            this._streamError = error;
            console.error('Audio track change failed:', error);
            throw error;
        } finally { this.isSeeking = false; }
        this._streamLoop();
        if (resume) this.video.play().catch(() => {});
    }

    // Inside CoreEngine
    switchSubtitleTrack(trackNumber) {
        if (!this.textTracks) return;

        // Pass 0 to turn subtitles off completely!
        for (let id in this.textTracks) {
            if (Number(id) === Number(trackNumber)) {
                this.textTracks[id].htmlTrack.mode = "showing";
                this.log(`Subtitles switched to track ${id}`);
            } else {
                this.textTracks[id].htmlTrack.mode = "hidden";
            }
        }
    }

    _waitForBuffer(buffer, action) {
        return new Promise((resolve, reject) => {
            const source = this.mediaSource;
            const cleanup = () => {
                buffer.removeEventListener('updateend', done);
                buffer.removeEventListener('error', failed);
                buffer.removeEventListener('abort', failed);
                source?.removeEventListener('sourceclose', failed);
            };
            const done = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error('SourceBuffer operation failed or was interrupted.')); };
            buffer.addEventListener('updateend', done, { once: true });
            buffer.addEventListener('error', failed, { once: true });
            buffer.addEventListener('abort', failed, { once: true });
            source?.addEventListener('sourceclose', failed, { once: true });
            try {
                if (action) action();
                if (!buffer.updating) done();
            } catch (error) { cleanup(); reject(error); }
        });
    }

    _queueBufferOperation(action, id = this.currentStreamId) {
        const buffer = this.sourceBuffer;
        const task = this._bufferQueue.then(async () => {
            if (id !== this.currentStreamId || buffer !== this.sourceBuffer) return;
            if (!buffer || this.mediaSource?.readyState === 'closed') throw new Error('MediaSource is closed.');
            if (buffer.updating) await this._waitForBuffer(buffer);
            if (id !== this.currentStreamId || buffer !== this.sourceBuffer) return;
            await this._waitForBuffer(buffer, () => action(buffer));
        });
        this._bufferQueue = task.catch(() => {});
        return task;
    }

    _appendToBuffer(data, id = this.currentStreamId) {
        return this._queueBufferOperation(buffer => buffer.appendBuffer(data), id);
    }

    async _runGarbageCollector() {
        if (this._gcPending || this.isSeeking || this.isRecording || this._destroying || !this.sourceBuffer) return;
        const cutoff = (this.video?.currentTime || 0) - 30;
        if (cutoff < this._lastEviction + 5) return;
        const ranges = this.sourceBuffer.buffered;
        if (!ranges.length || ranges.start(0) >= cutoff) return;
        this._gcPending = true;
        try {
            await this._queueBufferOperation(buffer => buffer.remove(0, cutoff));
            this._lastEviction = cutoff;
        } catch (error) { console.warn('Buffer eviction failed:', error); }
        finally { this._gcPending = false; }
    }

    destroy() {
        if (!this._destroyPromise) {
            this._destroying = true;
            this._destroyPromise = this._destroyInternal();
        }
        return this._destroyPromise;
    }

    async _destroyInternal() {
        this._destroying = true;
        try {
            await this._stopStream();
            await this._bufferQueue;
        } finally {
            let cleanupError = null;
            const release = action => {
                try { action(); }
                catch (error) { cleanupError ??= error; }
            };
            ++this._audioGeneration;
            if (this.audioEncoder?.state !== 'closed') {
                try { this.audioEncoder.close(); } catch (e) { }
            }
            this.audioEncoder = null;
            this._encoderWake = this._encoderError = null;

            if (this.diskStream) {
                try { await this.diskStream.abort(); } catch (e) { }
                this.diskStream = null;
            }
            this.isRecording = false;

            release(() => this.demuxer?.destroy());
            this.demuxer = null;
            release(() => { if (this._aacPtr) wasm._free_memory(this._aacPtr, this._aacCapacity); });
            this._aacPtr = this._aacCapacity = 0;
            this._pcmBuffer = new Float32Array(0);

            release(() => { if (this._onlineHandler) window.removeEventListener('online', this._onlineHandler); });
            if (this.mediaSource && this._sourceOpenHandler) {
                release(() => this.mediaSource.removeEventListener('sourceopen', this._sourceOpenHandler));
            }
            this._onlineHandler = this._sourceOpenHandler = null;
            if (this.mediaSource?.readyState === 'open' && this.sourceBuffer) {
                try {
                    if (this.sourceBuffer.updating) this.sourceBuffer.abort();
                    this.mediaSource.removeSourceBuffer(this.sourceBuffer);
                } catch (e) { }
            }
            if (this.video) {
                this.video.onseeking = this.video.ontimeupdate = this.video.onwaiting = this.video.onstalled = this.video.onerror = null;
                if (this._audioResumeHandler) this.video.removeEventListener('loadedmetadata', this._audioResumeHandler);
                this._audioResumeHandler = null;
                try {
                    this.video.pause();
                    this.video.removeAttribute('src');
                    this.video.load();
                } catch (e) { }
            }
            for (const item of Object.values(this.textTracks || {})) {
                const track = item.htmlTrack;
                try {
                    while (track.cues?.length) track.removeCue(track.cues[track.cues.length - 1]);
                    track.mode = 'disabled';
                } catch (e) { }
            }
            if (this._objectURL) {
                try { URL.revokeObjectURL(this._objectURL); } catch (e) { }
            }

            for (const [key, engine] of streamDictionary) {
                if (engine === this) streamDictionary.delete(key);
            }
            this._objectURL = null;
            this.mediaSource = this.sourceBuffer = this.sourceInput = this.video = null;
            this.initialHeaderData = this.mp4InitSegment = this.mkvHeader = null;
            this.videoTrack = this.audioTrack = null;
            this.cueMap = this.audioTracks = this.subtitleTracks = [];
            this.downloadBuffer = [];
            this.textTracks = {};
            this.onDownloadProgress = null;
            this._streamError = null;
            this._gcPending = false;
            this._bufferQueue = Promise.resolve();
            this._streamPromise = null;
            liveEngineCount--;
            if (liveEngineCount === 0) {
                wasm = null;
                while (yieldCallbacks.length) yieldCallbacks.shift()?.();
                if (yieldChannel) {
                    yieldChannel.port1.close();
                    yieldChannel.port2.close();
                    yieldChannel = null;
                }
            }
            if (cleanupError) throw cleanupError;
        }
    }


}
//#endregion

//#region EXPORT OBJECT
const streamDictionary = new Map();
const pendingFeeds = new Map();

export async function feed(source) {
    const dictKey = source;
    const cached = streamDictionary.get(dictKey);
    if (cached && !cached._destroying) return cached;
    if (cached) streamDictionary.delete(dictKey);
    const pending = pendingFeeds.get(dictKey);
    if (pending) return pending;

    const load = (async () => {
        const engine = new CoreEngine();
        try {
            await ensureWasm();
            const fetcher = new MKVFetcher(source);
            await fetcher.init();
            await engine.preload(fetcher);
            streamDictionary.set(dictKey, engine);
            return engine;
        } catch (error) {
            await engine.destroy();
            throw error;
        }
    })();
    pendingFeeds.set(dictKey, load);
    try {
        return await load;
    } finally {
        if (pendingFeeds.get(dictKey) === load) pendingFeeds.delete(dictKey);
    }
}

export class MKVPlayer {
    constructor(videoElement) {
        if (!videoElement) throw new Error("MKVPlayer requires a <video> element!");
        this.video = videoElement;
        this.engine = null;
    }

    async load(source) {
        if (!this.video) throw new Error('MKVPlayer has been destroyed. Create a new player.');
        if (this.engine) {
            if (this.engine.isRecording) await this._finishRecording(null);
            const old = this.engine;
            await old.destroy();
            for (const [key, value] of streamDictionary) if (value === old) streamDictionary.delete(key);
            this.engine = null;
        }
        const key = source;
        const cached = streamDictionary.get(key);
        if (cached) { await cached.destroy(); streamDictionary.delete(key); }
        await feed(source);
        this.engine = streamDictionary.get(key);
        this.engine.attachVideo(this.video);
    }

    async play() {
        if (this.engine?._needsPlaybackReset) {
            if (!this.engine.cueMap.length) throw new Error('Reload this file to resume playback after recording; it has no seek table.');
            await this.engine._onSeeking(true);
            this.engine._needsPlaybackReset = false;
        }
        return this.video.play().catch(e => {
            if (e.name !== 'AbortError') console.error("Play prevented:", e);
        });
    }

    pause() { this.video.pause(); }
    seek(timeInSeconds) { this.video.currentTime = timeInSeconds; }
    getAudioTracks() { return this.engine ? this.engine.audioTracks : []; }
    getSelectedAudioTrack() { return this.engine?.audioTrack || null; }
    getPerformanceStats() { return this.engine?.getPerformanceStats() || null; }
    setAudioTrack(trackNumber) { return this.engine?.switchAudioTrack(trackNumber); }

    getSubtitleTracks() { return this.engine ? this.engine.subtitleTracks : []; }
    setSubtitleTrack(trackNumber) { if (this.engine) this.engine.switchSubtitleTrack(trackNumber); }


    async destroy() {
        const engine = this.engine;
        let recordingError = null;
        if (engine?.isRecording) {
            try { await this._finishRecording(null); }
            catch (error) { recordingError = error; }
        }
        try {
            await engine?.destroy();
        } finally {
            this.engine = null;
            if (this.video) {
                try {
                    this.video.pause();
                    this.video.removeAttribute('src');
                    this.video.load();
                } catch (e) { }
                this.video = null;
            }
        }
        if (recordingError) throw recordingError;
    }

    async toggleRecording(onStateChange, onProgress, customName = "Media") {
        const engine = this.engine;
        if (!engine || engine.isSeeking || engine._destroying) return;
        if (engine.isRecording) return this._finishRecording(onStateChange);
        if (!window.showSaveFilePicker) throw new Error('This browser does not support direct-to-disk saving.');
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: customName,
                types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }] });
        } catch (error) { if (error.name === 'AbortError') return; throw error; }
        engine.isSeeking = true;
        try {
            await engine._stopStream();
            engine.video.pause();
            engine.demuxer.reset();
            if (engine.needsAudioTranscode) await engine._bootAudioEncoder(engine.audioTrack);
            engine.diskStream = await handle.createWritable();
            await engine.diskStream.write(engine.mp4InitSegment);
            engine.currentOffset = engine.firstClusterOffset;
            engine.isRecording = true;
            engine.onDownloadProgress = percent => {
                onProgress?.(percent);
                if (percent >= 100) this._finishRecording(onStateChange).catch(error => console.error('Recording failed:', error));
            };
        } catch (error) {
            if (engine.diskStream) await engine.diskStream.abort().catch(() => {});
            engine.diskStream = null;
            throw error;
        } finally { engine.isSeeking = false; }
        onStateChange?.('recording');
        engine._streamLoop();
    }

    _finishRecording(onStateChange) {
        if (this._finishPromise) return this._finishPromise;
        const engine = this.engine;
        if (!engine?.isRecording) return Promise.resolve();
        this._finishPromise = (async () => {
            engine.isSeeking = true;
            engine.onDownloadProgress = null;
            try {
                await engine._stopStream();
                const id = engine.currentStreamId;
                await engine._drainAudio(id, undefined, true);
                await engine._emitSegment(id);
                const mfra = engine.demuxer.get_mfra_box();
                if (mfra.length) await engine.diskStream.write(mfra);
                await engine.diskStream.close();
            } catch (error) {
                await engine.diskStream?.abort().catch(() => {});
                throw error;
            } finally {
                engine.diskStream = null;
                engine.isRecording = false;
                engine.isSeeking = false;
                // Playback must reset its decoder/timeline before continuing.
                engine._eof = true;
                engine._needsPlaybackReset = true;
                onStateChange?.('stopped');
            }
        })().finally(() => { this._finishPromise = null; });
        return this._finishPromise;
    }
}
