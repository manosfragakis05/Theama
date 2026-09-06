import initModule from './streaming-engine.js';
let wasm = null;

const MSE = window.ManagedMediaSource || window.MediaSource;

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

// Bypasses background tab throttling
const yieldThread = () => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
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

    dispose() {
        clearTimeout(this._timer);
        if (this._externalSignal) this._externalSignal.removeEventListener('abort', this._onExternalAbort);
    }
}

class MKVFetcher {
    constructor(source) {
        this.source = source;
        this.type = source instanceof File ? 'file' : 'url';
        this.size = Infinity;
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
        if (this.size !== Infinity && end > this.size) end = this.size;
        if (start >= end) return new Uint8Array(0);

        if (this.type === 'file') {
            return new Uint8Array(await this.source.slice(start, end).arrayBuffer());
        } else {
            const watchdog = new FetchWatchdog(RANGE_FETCH_TIMEOUT_MS, signal);
            try {
                const res = await fetch(this.source, {
                    headers: { 'Range': `bytes=${start}-${end - 1}` },
                    signal: watchdog.signal
                });
                if (!res.ok) {
                    if (res.status === 416) return new Uint8Array(0);
                    throw new Error(`HTTP Error ${res.status} for range ${start}-${end - 1}`);
                }
                watchdog.bump(); // headers are in — give the body download its own fresh window
                return new Uint8Array(await res.arrayBuffer());
            } finally {
                watchdog.dispose();
            }
        }
    }

    // Requests chunks but yields the data in tiny fragments to feed bytes in wasm immediately
    async *stream(start, end, signal) {
        if (this.size !== Infinity && end > this.size) end = this.size;
        if (start >= end) return;

        let streamObj;
        let watchdog = null;
        if (this.type === 'file') {
            streamObj = this.source.slice(start, end).stream();
        } else {
            // Same stalled-connection risk as read(), but here we can do better:
            // once bytes start flowing we reset the deadline on every chunk, so a
            // connection has to go fully silent (not just slow) to get killed.
            watchdog = new FetchWatchdog(RANGE_FETCH_TIMEOUT_MS, signal);
            let res;
            try {
                res = await fetch(this.source, {
                    headers: { 'Range': `bytes=${start}-${end - 1}` },
                    signal: watchdog.signal
                });
            } catch (err) {
                watchdog.dispose();
                throw err;
            }
            if (!res.ok) {
                watchdog.dispose();
                if (res.status === 416) return;
                throw new Error(`HTTP Error ${res.status} for range ${start}-${end - 1}`);
            }
            watchdog.bump(); // headers are in — the body reads below will keep bumping this
            streamObj = res.body;
        }

        const reader = streamObj.getReader();
        let naturallyFinished = false; // Track if the chunk completed gracefully

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (watchdog) watchdog.bump(); // saw activity — push the stall deadline back out
                if (done) {
                    naturallyFinished = true; // The chunk is 100% downloaded
                    break;
                }
                yield value;
            }
        } catch (err) {
            // AbortError = a real cancellation (seek/destroy/track switch) — end quietly.
            // Anything else, including our own TimeoutError from a stalled connection,
            // propagates up so callers (e.g. _streamLoop's retry/backoff) can react to it.
            if (err.name !== 'AbortError') throw err;
        } finally {
            reader.releaseLock();
            if (watchdog) watchdog.dispose();
            if (!naturallyFinished && streamObj && typeof streamObj.cancel === 'function') {
                streamObj.cancel().catch(() => { });
            }
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
            break; // Stop after patching the Segment tag
        }
    }
}

class Demuxer {
    // Allocate wasm memory to convert the js codec string
    constructor(videoId, audioId, width, height, duration, codecId) {
        const encoder = new TextEncoder();
        const codecBytes = encoder.encode(codecId + "\0");
        const codecPtr = wasm._alloc_memory(codecBytes.length);
        new Uint8Array(getWasmMemory(), codecPtr, codecBytes.length).set(codecBytes);

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
        if (len === 0) return new Uint8Array(0);

        const data = new Uint8Array(getWasmMemory(), ptr, len).slice();
        wasm._free_segment(ptr, len);
        return data;
    }

    init(chunkData) {
        const chunkPtr = wasm._alloc_memory(chunkData.length);
        new Uint8Array(getWasmMemory(), chunkPtr, chunkData.length).set(chunkData);
        const ptr = wasm._demuxer_init(this.ptr, chunkPtr, chunkData.length);
        wasm._free_memory(chunkPtr, chunkData.length);
        return this._handleBufferResult(ptr);
    }

    get_mp4_segment() {
        const ptr = wasm._demuxer_get_mp4_segment(this.ptr);
        return this._handleBufferResult(ptr);
    }

    get_mfra_box() {
        if (!wasm._demuxer_get_mfra_box) return new Uint8Array(0); // Safety check
        const ptr = wasm._demuxer_get_mfra_box(this.ptr);
        return this._handleBufferResult(ptr);
    }

    parse_chunk(chunkData, isFinal) {
        const chunkPtr = wasm._alloc_memory(chunkData.length);
        new Uint8Array(getWasmMemory(), chunkPtr, chunkData.length).set(chunkData);
        const frames = wasm._demuxer_parse_chunk(this.ptr, chunkPtr, chunkData.length, isFinal);
        wasm._free_memory(chunkPtr, chunkData.length);
        return frames;
    }

    reset() { wasm._demuxer_reset(this.ptr); }
    destroy() { wasm._demuxer_destroy(this.ptr); }
}

class CoreEngine {
    constructor() {
        this.video = null;
        this.chunkSize = 10 * 1024 * 1024;

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

        this.audioFramesIn = 0;
        this.audioFramesOut = 0;
    }

    async _bootAudioEncoder(targetAudioTrack) {
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

        // 2. The Hardware Negotiation Loop
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
                this.log(`Hardware accepted ${test.channels} channels (${test.vbr ? 'VBR' : 'CBR'}).`);
                finalConfig = config;
                finalChannels = test.channels;
                break; // Stop testing once the hardware accepts one
            }
        }

        // Absolute Fail-Safe (If everything fails)
        if (!finalConfig) {
            this.log("Hardware rejected all configs. Forcing basic stereo.");
            finalChannels = 2;
            finalConfig = {
                codec: 'mp4a.40.2',
                sampleRate: currentSampleRate,
                numberOfChannels: 2,
                bitrate: 128000,
                bitrateMode: "constant"
            };
        }

        this.encoderChannels = finalChannels;

        // 4. Beam the final decision down to Rust so it downmixes perfectly
        if (this.demuxer && this.demuxer.ptr) {
            wasm._demuxer_set_target_channels(this.demuxer.ptr, this.encoderChannels);
        }

        // 5. Boot the Hardware Encoder
        this.audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => {
                this.audioFramesOut++;
                const aacData = new Uint8Array(chunk.byteLength);
                chunk.copyTo(aacData);
                const aacPtr = wasm._alloc_memory(aacData.length);
                new Uint8Array(getWasmMemory(), aacPtr, aacData.length).set(aacData);

                const dtsSamples = BigInt(Math.floor((chunk.timestamp * currentSampleRate) / 1000000));
                wasm._demuxer_append_aac(this.demuxer.ptr, aacPtr, aacData.length, dtsSamples);
                wasm._free_memory(aacPtr, aacData.length);
            },
            error: (e) => console.error("Hardware Encoder Error:", e)
        });

        this.audioEncoder.configure(finalConfig);
        this.log(`Hardware Audio Encoder successfully rebuilt for ${this.encoderChannels} channels.`);
    }

    attachVideo(videoElement) {
        this.video = videoElement;

        this.textTracks = {};
        if (this.subtitleTracks && this.subtitleTracks.length > 0) {
            this.subtitleTracks.forEach((track, index) => {
                const t = this.video.addTextTrack("subtitles", track.language, track.language);
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

        this.video.onwaiting = () => this._streamLoop();
        this.video.onstalled = () => this._streamLoop();
        this._onlineHandler = () => this._streamLoop();
        window.addEventListener('online', this._onlineHandler);

        this.video.src = URL.createObjectURL(this.mediaSource);
        this.log("Video tag attached. Stream routed to screen.");
    }

    async preload(fetcher) {
        this._resetState();
        this.sourceInput = fetcher;

        this.log("Probing for MKV clusters...");

        const maxProbe = 100 * 1024 * 1024;
        let capacity = 2 * 1024 * 1024;

        if (!wasm) wasm = await initModule();
        let ptr = wasm._alloc_memory(capacity);
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
                    console.log(`🧠 [Probe] Copying ${chunk.length} bytes to WASM RAM. Current Buffer: ${currentSize}`);

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
                        wasmHeap = new Uint8Array(wasm.memory.buffer, ptr, capacity);
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

        patchSegmentToUnknown(wasmHeap);

        this.initialHeaderData = wasmHeap.slice(0, firstClusterIndex);

        let jsonPtr = wasm._get_mkv_info_fast_json(ptr, currentSize);

        const jsonStr = wasm.UTF8ToString(jsonPtr);

        this.mkvHeader = JSON.parse(jsonStr);
        wasm._free_string(jsonPtr);
        wasm._free_memory(ptr, capacity);

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
        const audioTrack = this.audioTracks.length > 0 ? this.audioTracks[0] : null;

        if (videoTrack.codec_id !== "V_MPEG4/ISO/AVC" && videoTrack.codec_id !== "V_MPEGH/ISO/HEVC") {
            this.log(`Critical: Unsupported video codec ${videoTrack.codec_id}`);
            alert(`Sorry, only H.264 and HEVC (H.265) video tracks are supported!`);
            throw new Error("Unsupported video codec.");
        }

        if (this.mkvHeader.cues_position) {
            const pos = Number(this.mkvHeader.cues_position);

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
            await this._configureAudioPipeline(videoTrack, audioTrack);
        }

        this.videoTrack = videoTrack;
        this.audioTrack = audioTrack;

        this.mediaSource = new MSE();
        this.mediaSource.addEventListener('sourceopen', () => this._onSourceOpen());
    }

    async _configureAudioPipeline(videoTrack, audioTrack) {
        // 1. If no audio track exists, shut the pipeline down.
        if (!audioTrack) {
            this.needsAudioTranscode = false;
            if (this.demuxer) this.demuxer.setTranscodeMode(false);
            return;
        }

        // 2. Check Native Browser Support
        const audioMime = `video/mp4; codecs="${videoTrack.codec_string}, ${audioTrack.codec_string}"`;
        let canPlayNatively = false;

        const MSE = window.ManagedMediaSource || window.MediaSource;
        if (MSE) {
            try { canPlayNatively = MSE.isTypeSupported(audioMime); } catch (e) { }
        }

        // 3. The Transcoder Hit List
        // - AC3/EAC3/DTS/TRUEHD: Browsers don't have licenses for these.
        // - FLAC/OPUS: Browsers support them, but your Rust code currently only writes AAC MP4 boxes.
        const strictlyUnsupported = ["A_TRUEHD", "A_DTS", "A_AC3", "A_EAC3", "A_FLAC", "A_OPUS"];

        // 4. Route the Audio
        if (canPlayNatively && !strictlyUnsupported.includes(audioTrack.codec_id)) {
            this.log(`Direct Play Supported! Bypassing Transcoder for: ${audioTrack.codec_id}`);

            this.needsAudioTranscode = false;
            if (this.demuxer) this.demuxer.setTranscodeMode(false);

            // Turn off the hardware encoder if it was running
            if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
                try { this.audioEncoder.close(); } catch (e) { }
            }
        } else {
            this.log(`Routing to Transcoder: ${audioTrack.codec_id}`);

            this.needsAudioTranscode = true;
            if (this.demuxer) this.demuxer.setTranscodeMode(true);

            // Pass the explicitly provided track to the bootloader!
            await this._bootAudioEncoder(audioTrack);
        }
    }

    async _onSourceOpen() {
        try {
            let mime = `video/mp4; codecs="${this.videoTrack.codec_string}`;
            if (this.audioTrack) {
                mime += this.needsAudioTranscode ? `, mp4a.40.2"` : `, ${this.audioTrack.codec_string}"`;
            } else { mime += `"`; }

            this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
            this.sourceBuffer.mode = 'segments';
            this.mediaSource.duration = this.mkvHeader.duration;

            await new Promise(r => setTimeout(r, 100));

            const initData = this.demuxer.init(this.initialHeaderData);

            this.mp4InitSegment = initData;

            if (!initData || initData.length < 100) throw new Error("Invalid Init Segment from Rust");
            await this._appendToBuffer(initData);

            this.currentOffset = this.firstClusterOffset || 0;
            this.log("▶️ Stream routed to screen. Buffering clusters...");
            this._streamLoop();

        } catch (error) {
            console.error("Engine Crash in _onSourceOpen:", error);
        }
    }

    async _streamLoop() {
        if (!this.sourceBuffer || this.mediaSource.readyState !== 'open') return;

        let myStreamId = this.currentStreamId;
        if (this.isFetching || this.currentOffset >= this.sourceInput.size) return;
        this.isFetching = true;
        this._activeLoops = (this._activeLoops || 0) + 1;

        try {
            while (this.currentOffset < this.sourceInput.size && myStreamId === this.currentStreamId) {
                if (this.mediaSource.readyState !== 'open') break;

                let bufferedEnd = this.video ? this.video.currentTime : 0;

                for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
                    let end = this.sourceBuffer.buffered.end(i);
                    if (end > bufferedEnd) bufferedEnd = end;
                }

                try {
                    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
                        let end = this.sourceBuffer.buffered.end(i);
                        if (end > bufferedEnd) bufferedEnd = end;
                    }
                } catch (e) {
                    break; // Buffer was removed, kill the loop cleanly
                }

                // THE NEW DYNAMIC RAM LIMITER
                let limit = this.video ? (bufferedEnd - this.video.currentTime) : bufferedEnd;

                const durationSeconds = Math.max(this.mkvHeader.duration, 1);
                const bytesPerSecond = this.sourceInput.size / durationSeconds;

                // 2. Convert the forward buffer time into Megabytes
                let forwardBufferMB = (limit * bytesPerSecond) / (1024 * 1024);

                // 3. Stop fetching if we have parked more than 50MB in the browser's RAM
                if (forwardBufferMB > 50 && !this.isRecording) {
                    break;
                }

                this.abortController = new AbortController();
                try {
                    let bytesProcessed = 0;

                    for await (const chunkData of this.sourceInput.stream(this.currentOffset, this.currentOffset + this.chunkSize, this.abortController.signal)) {
                        if (myStreamId !== this.currentStreamId) break;

                        const isFinal = (this.currentOffset + bytesProcessed + chunkData.length) >= this.sourceInput.size;
                        const framesStaged = this.demuxer.parse_chunk(chunkData, isFinal);

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

                        if (this.audioTrack && this.needsAudioTranscode && this.audioEncoder?.state === 'configured') {

                            // 1. Read the negotiated limits (from our hardware handshake!)
                            const numChannels = this.encoderChannels || 2;
                            const sampleRate = this.audioTrack.sample_rate || 48000;
                            const BYTES_PER_PLANE = 768000;

                            while (true) {
                                const samples = wasm._demuxer_decode_next_audio_frame(this.demuxer.ptr);
                                if (samples <= 0) break;

                                const pcmPtr = wasm._get_audio_ptr();
                                const dtsBigInt = wasm._demuxer_get_last_audio_dts(this.demuxer.ptr);

                                let planarData = [];

                                // 2. Dynamically scoop the exact number of channels in the standard SMPTE order
                                for (let ch = 0; ch < numChannels; ch++) {
                                    const planeOffset = pcmPtr + (ch * BYTES_PER_PLANE);
                                    const rawBytes = new Uint8Array(getWasmMemory(), planeOffset, samples * 4).slice();
                                    planarData.push(new Float32Array(rawBytes.buffer));
                                }

                                // 3. Flatten the multi-dimensional planes into one contiguous array for WebCodecs
                                const totalLength = planarData.reduce((acc, arr) => acc + arr.length, 0);
                                const combinedFloats = new Float32Array(totalLength);
                                let offset = 0;
                                for (let plane of planarData) {
                                    combinedFloats.set(plane, offset);
                                    offset += plane.length;
                                }

                                // 4. Build the AudioData object dynamically
                                const audioData = new AudioData({
                                    format: 'f32-planar',
                                    sampleRate: sampleRate,
                                    numberOfChannels: numChannels,
                                    numberOfFrames: samples,
                                    timestamp: Number((BigInt(dtsBigInt) * 1000000n) / BigInt(sampleRate)),
                                    data: combinedFloats
                                });

                                this.audioEncoder.encode(audioData);
                                audioData.close();
                                this.audioFramesIn++;
                            }

                            // Wait for the encoder queue to empty naturally
                            while (this.audioEncoder && this.audioEncoder.encodeQueueSize > 0 && this.audioEncoder.state === 'configured') {
                                await yieldThread();
                            }
                            await yieldThread();
                        }

                        if (framesStaged >= 30 || isFinal) {
                            const segment = this.demuxer.get_mp4_segment();

                            if (this.isRecording && this.diskStream && segment.length > 0) {
                                // Stream directly to hard drive at maximum speed!
                                await this.diskStream.write(segment);
                            }

                            if (isFinal && this.isRecording && this.diskStream) {
                                console.log("✅ Reached EOF. Generating MFRA box...");

                                if (this.onDownloadProgress) this.onDownloadProgress(100);
                            }

                            if (segment.length > 0 && this.sourceBuffer && !this.isRecording) {
                                await this._appendToBuffer(segment);

                                // 🛑 THE NEW, SAFE NUDGE BLOCK
                                try {
                                    if (this.video && this.sourceBuffer.buffered.length > 0) {
                                        // 1. Explicit Autostart (No more accidental seek-starts!)
                                        if (this.video.currentTime === 0 && this.video.paused) {
                                            this.video.play().catch(() => { });
                                        }

                                        // 2. Safe Gap Jump (Only jump true gaps, no artificial kicks!)
                                        if (!this.video.paused && this.video.readyState <= 2) {
                                            try {
                                                for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
                                                    let start = this.sourceBuffer.buffered.start(i);
                                                    if (start > this.video.currentTime) {
                                                        this.video.currentTime = start + 0.01;
                                                        break;
                                                    }
                                                }
                                            }
                                            catch (e) { break; }
                                        }
                                    }
                                } catch (e) { }
                            }
                        }
                        bytesProcessed += chunkData.length;

                        if (this.isRecording && this.onDownloadProgress && this.sourceInput.size !== Infinity) {
                            const currentBytes = this.currentOffset + bytesProcessed;
                            const percent = Math.floor((currentBytes / this.sourceInput.size) * 100);
                            this.onDownloadProgress(percent);
                        }
                    }

                    this.currentOffset += bytesProcessed;
                } catch (err) {
                    if (err?.name === 'AbortError') break;
                    else {
                        console.error("Fetch error:", err);
                        await new Promise(r => setTimeout(r, 3000)); // The Wifi backoff!
                        break;
                    }
                } finally {
                    this.abortController = null;
                }
            }
        } finally {                                          // NEW
            this._activeLoops = Math.max(0, this._activeLoops - 1);
            if (myStreamId === this.currentStreamId) this.isFetching = false;
        }
    }

    _onTimeUpdate() {
        if (!this.sourceBuffer || !this.video || this.mediaSource.readyState !== 'open') return;

        this._runGarbageCollector();
        this._streamLoop();
    }

    async _onSeeking() {
        if (!this.video || !this.cueMap || this.cueMap.length === 0 || !this.mediaSource || this.mediaSource.readyState !== 'open') {
            console.warn("No seek table found. Seeking is disabled for this file.");
            return;
        }

        // Stop the player from nuking itself on micro-nudges
        if (this.sourceBuffer) {
            let target = this.video.currentTime;
            let isBuffered = false;
            for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
                if (target >= this.sourceBuffer.buffered.start(i) && target < this.sourceBuffer.buffered.end(i)) {
                    isBuffered = true;
                    break;
                }
            }
            if (isBuffered) return;
        }

        if (this.abortController) { this.abortController.abort(); this.abortController = null; }
        if (this.isSeeking) return;

        this.isSeeking = true;
        this.currentStreamId++;

        if (this.textTracks) {
            for (let trackId in this.textTracks) {
                const track = this.textTracks[trackId].htmlTrack;
                if (track && track.cues) {
                    // Must iterate backwards when removing from an array
                    for (let i = track.cues.length - 1; i >= 0; i--) {
                        track.removeCue(track.cues[i]);
                    }
                }
            }
        }

        // 🛑 THE FATAL DOUBLE-WIPE FIX: Clean, single execution!
        try {
            if (this.sourceBuffer) {
                if (this.sourceBuffer.updating) {
                    await new Promise(r => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
                }
                if (this.sourceBuffer.buffered.length > 0) {
                    const wipeStart = Math.max(0, this.video.currentTime - 1);
                    this.sourceBuffer.remove(wipeStart, this.mediaSource.duration);
                    await new Promise(r => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
                }
            }
        } catch (e) { }

        let bestCue = this.cueMap[0];
        for (let i = 0; i < this.cueMap.length; i++) {
            if (this.cueMap[i].time <= this.video.currentTime) bestCue = this.cueMap[i];
            else break;
        }

        const segmentPayloadStart = this.firstClusterOffset - Number(this.cueMap[0].offset);
        this.currentOffset = segmentPayloadStart + Number(bestCue.offset);

        if (this.demuxer) this.demuxer.reset();
        if (this.audioTrack && this.needsAudioTranscode) this._bootAudioEncoder(this.audioTrack);

        this.isFetching = false;
        this.isSeeking = false;
        this._streamLoop();
        try { await this.video.play(); } catch (e) { }
    }

    async switchAudioTrack(newTrackNumber) {
        if (!this.video) return;
        const targetTime = this.video.currentTime;
        this.video.pause();

        this.video.onseeking = null;

        // Stop the current fetch loop immediately
        if (this.abortController) { this.abortController.abort(); this.abortController = null; }
        this.currentStreamId++;

        // Safely wipe the old video buffer
        try {
            if (this.sourceBuffer) {
                if (this.sourceBuffer.updating) {
                    await new Promise(r => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
                }
                if (this.sourceBuffer.buffered.length > 0) {
                    this.sourceBuffer.remove(0, this.mediaSource.duration);
                    await new Promise(r => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
                }
            }
        } catch (e) { }

        // 3. Tear down the old Rust engine and build a new one
        if (this.demuxer) this.demuxer.destroy();

        const newAudioTrack = this.audioTracks.find(t => t.track_number === Number(newTrackNumber));
        if (!newAudioTrack) return;
        this.audioTrack = newAudioTrack;

        this.demuxer = new Demuxer(
            BigInt(this.videoTrack.track_number), BigInt(newAudioTrack.track_number),
            this.videoTrack.width, this.videoTrack.height,
            this.mkvHeader.duration * 1000, this.videoTrack.codec_id
        );

        // 4. Configure transcoding for the new track
        if (newAudioTrack) {
            await this._configureAudioPipeline(this.videoTrack, newAudioTrack);
        }

        // 5. Send the new MP4 headers to the browser
        const newInitSegment = this.demuxer.init(this.initialHeaderData);
        await this._appendToBuffer(newInitSegment);

        // Clamp the variables to zero so the stream can reset to the beginning if no cues exist
        let bestCue = (this.cueMap && this.cueMap.length > 0) ? this.cueMap[0] : { time: 0, offset: 0 };
        for (let i = 0; i < this.cueMap.length; i++) {
            if (this.cueMap[i].time <= targetTime) bestCue = this.cueMap[i];
            else break;
        }

        const segmentPayloadStart = this.firstClusterOffset - Number(this.cueMap.length > 0 ? this.cueMap[0].offset : 0);
        this.currentOffset = segmentPayloadStart + Number(bestCue.offset);

        // Jump the video to the new time
        if (bestCue && this.video.currentTime !== bestCue.time) {
            this.video.currentTime = bestCue.time;
        }

        // Re-hook the seeking event after the jump finishes
        setTimeout(() => {
            this.video.onseeking = () => this._onSeeking();
        }, 100);

        // 8. Start fetching the new language!
        this.isFetching = false;
        this.isSeeking = false;
        this._streamLoop();
        try { await this.video.play(); } catch (e) { }
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

    // THE NEW, SAFE CODE
    async _appendToBuffer(data) {
        return new Promise((resolve, reject) => {
            if (!this.sourceBuffer || this.mediaSource.readyState !== 'open') {
                return resolve();
            }

            if (this.sourceBuffer.updating) {
                setTimeout(() => this._appendToBuffer(data).then(resolve).catch(reject), 50);
                return;
            }
            try {
                const onUpdate = () => { cleanup(); resolve(); };
                const onError = (e) => { cleanup(); reject(e); };
                const cleanup = () => {
                    this.sourceBuffer.removeEventListener('updateend', onUpdate);
                    this.sourceBuffer.removeEventListener('error', onError);
                };
                this.sourceBuffer.addEventListener('updateend', onUpdate);
                this.sourceBuffer.addEventListener('error', onError);

                this.sourceBuffer.appendBuffer(data);
            } catch (e) { reject(e); }
        });
    }

    async _runGarbageCollector() {
        if (!this.sourceBuffer || this.sourceBuffer.updating || this.mediaSource.readyState !== 'open') return;

        const currentTime = this.video ? this.video.currentTime : 0;
        const safeBackBuffer = 30; // Keep 30 seconds of history

        // Only delete if we actually have more than 30 seconds of history
        if (currentTime > safeBackBuffer) {
            try {
                await new Promise((resolve, reject) => {
                    const onUpdate = () => { cleanup(); resolve(); };
                    const onError = (e) => { cleanup(); reject(e); };
                    const cleanup = () => {
                        this.sourceBuffer.removeEventListener('updateend', onUpdate);
                        this.sourceBuffer.removeEventListener('error', onError);
                    };

                    this.sourceBuffer.addEventListener('updateend', onUpdate);
                    this.sourceBuffer.addEventListener('error', onError);

                    // Start the asynchronous deletion
                    this.sourceBuffer.remove(0, currentTime - safeBackBuffer);
                });

                this.log(`🗑️ Garbage Collector: Flushed buffer from 0 to ${currentTime - safeBackBuffer}`);
            } catch (e) {
                this.log(`Garbage collection skipped: ${e.message}`);
            }
        }
    }

    // Completly reset engine
    async destroy() {
        this.log("💥 Commencing total engine teardown...");

        // 1. Stop new work, cancel the fetch in flight
        this.currentStreamId++;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        // 2. Remove the window-level listener — otherwise it leaks forever
        if (this._onlineHandler) {
            window.removeEventListener('online', this._onlineHandler);
        }

        // 3. Wait for any in-flight _streamLoop() to actually unwind before
        //    nulling anything it might still touch mid-chunk. Bounded so a
        //    stuck append can never hang teardown forever.
        const waitStart = Date.now();
        while ((this._activeLoops || 0) > 0 && Date.now() - waitStart < 2000) {
            await new Promise(r => setTimeout(r, 20));
        }
        this.isFetching = false;

        // 4. Erase Rust WASM allocations (drops all the demuxer's internal
        //    Vec buffers on the Rust side too)
        if (this.demuxer) {
            this.demuxer.destroy();
            this.demuxer = null;
        }

        // 5. Kill the hardware audio encoder
        if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
            try { this.audioEncoder.close(); } catch (e) { }
            this.audioEncoder = null;
        }

        // 6. Explicitly empty the SourceBuffer's media data — safe now,
        //    since step 3 guarantees nothing is still mid-append
        if (this.sourceBuffer && this.mediaSource) {
            try {
                if (this.sourceBuffer.updating) this.sourceBuffer.abort();
                if (this.sourceBuffer.buffered.length > 0) {
                    this.sourceBuffer.remove(0, this.mediaSource.duration || Infinity);
                }
            } catch (e) { }
        }

        // 7. Sever the video element and nuke browser RAM buffers
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();

            if (this.textTracks) {
                for (let trackId in this.textTracks) {
                    const track = this.textTracks[trackId].htmlTrack;
                    if (track && track.cues) {
                        for (let i = track.cues.length - 1; i >= 0; i--) {
                            track.removeCue(track.cues[i]);
                        }
                    }
                    track.mode = "disabled";
                }
            }

            this.video.onseeking = null;
            this.video.ontimeupdate = null;
            this.video.onwaiting = null;
            this.video.onstalled = null;
        }

        // 8. Dereference MSE components
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try { this.mediaSource.endOfStream(); } catch (e) { }
        }
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.sourceInput = null;
        this.video = null;
        this.downloadBuffer = [];   // declared in the constructor but never read elsewhere — worth checking if it's dead code
    }
}

//#region EXPORT OBJECT
const streamDictionary = new Map();

export async function feed(source) {
    if (!wasm) wasm = await initModule();

    const dictKey = source instanceof File ? source.name : source;

    if (streamDictionary.has(dictKey)) return streamDictionary.get(dictKey);

    const fetcher = new MKVFetcher(source);
    await fetcher.init();

    const engine = new CoreEngine();
    await engine.preload(fetcher);

    streamDictionary.set(dictKey, engine);
    return engine;
}

export class MKVPlayer {
    constructor(videoElement) {
        if (!videoElement) throw new Error("MKVPlayer requires a <video> element!");
        this.video = videoElement;
        this.engine = null;
    }

    async load(source) {
        if (this.engine) {
            this.engine.currentStreamId++;
            if (this.engine.abortController) this.engine.abortController.abort();
        }

        // Completely reset the video tag
        if (this.video) {
            this.video.pause();
            this.video.currentTime = 0;
            this.video.removeAttribute('src');
            this.video.load();
        }

        const isFile = source instanceof File;
        const dictKey = isFile ? source.name : source;

        // 2. Delete the dead engine from the dictionary! 
        // Reusing a detached MediaSource is illegal in Chrome/Safari.
        streamDictionary.delete(dictKey);

        // 3. Load the new stream
        await feed(source);

        // 4. Attach the fresh engine
        this.engine = streamDictionary.get(dictKey);
        this.engine.attachVideo(this.video);
    }

    play() {
        this.video.play().catch(e => {
            if (e.name !== 'AbortError') console.error("Play prevented:", e);
        });
    }

    pause() { this.video.pause(); }
    seek(timeInSeconds) { this.video.currentTime = timeInSeconds; }
    getAudioTracks() { return this.engine ? this.engine.audioTracks : []; }
    setAudioTrack(trackNumber) { if (this.engine) this.engine.switchAudioTrack(trackNumber); }

    getSubtitleTracks() { return this.engine ? this.engine.subtitleTracks : []; }
    setSubtitleTrack(trackNumber) { if (this.engine) this.engine.switchSubtitleTrack(trackNumber); }


    // Reset engine * MAKE SURE TO DESTROY THE VIDEO ELEMENT IN HTML *
    async destroy() {
        if (this.engine) {
            // Flush any active direct-to-disk writes
            if (this.engine.isRecording) {
                await this._finishRecording(null);
            }

            // Wipe the engine from the global dictionary so a fresh one is built next time
            for (let [key, val] of streamDictionary.entries()) {
                if (val === this.engine) {
                    streamDictionary.delete(key);
                    break;
                }
            }

            // Execute the total teardown
            await this.engine.destroy();
            this.engine = null;
        }

        // DOM Failsafe
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
    }

    async toggleRecording(onStateChange, onProgress, customName = "Media") {
        if (!this.engine) return;

        if (!this.engine.isRecording) {
            try {
                if (!window.showSaveFilePicker) {
                    alert("Direct-to-disk saving is currently only supported on Desktop Chrome/Edge/Opera.");
                    return;
                }

                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: customName,
                    types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
                });

                this.engine.diskStream = await fileHandle.createWritable();
                this.engine.isRecording = true;

                this.video.pause();

                // 🛑 1. WIPE THE RUST ENGINE CLEAN (Resets sequence to 1 and fixes timestamps)
                if (this.engine.demuxer) this.engine.demuxer.reset();

                // 🛑 2. WIPE THE AUDIO ENCODER CLEAN (Destroys ghost frames)
                if (this.engine.audioTrack && this.engine.needsAudioTranscode) this.engine._bootAudioEncoder();

                // 🛑 3. WRITE THE MP4 HEADERS
                if (this.engine.mp4InitSegment) {
                    await this.engine.diskStream.write(new Uint8Array(this.engine.mp4InitSegment));
                }

                this.engine.onDownloadProgress = (percent) => {
                    if (onProgress) onProgress(percent);
                    if (percent >= 100) this._finishRecording(onStateChange);
                };

                // 🛑 4. JUMP TO THE TRUE START OF THE VIDEO (Skips MKV text headers!)
                this.engine.currentOffset = this.engine.firstClusterOffset || 0;
                this.engine.currentStreamId++;

                this.engine.isFetching = false;
                this.engine._streamLoop();

                if (onStateChange) onStateChange("recording");

            } catch (err) {
                console.log("User cancelled the save dialog:", err);
            }
        } else {
            // User manually clicked stop
            this._finishRecording(onStateChange);
        }
    }

    async _finishRecording(onStateChange) {
        if (!this.engine || !this.engine.isRecording) return;

        // 1. Immediately stop the stream loop from fetching new chunks
        this.engine.isRecording = false;
        this.engine.onDownloadProgress = null;

        if (this.engine.diskStream) {
            console.log("🛑 Commencing graceful shutdown...");

            // 2. FLUSH THE AUDIO ENCODER (Fixes the missing audio/dropped buffers!)
            if (this.engine.audioEncoder && this.engine.audioEncoder.state === 'configured') {
                try {
                    console.log("Flushing hardware audio encoder...");
                    await this.engine.audioEncoder.flush();
                } catch (e) { console.warn("Audio flush skipped:", e); }
            }

            if (this.engine.demuxer) {
                // 3. Package any trailing audio frames that just flushed
                const finalSegment = this.engine.demuxer.get_mp4_segment();
                if (finalSegment && finalSegment.length > 0) {
                    await this.engine.diskStream.write(finalSegment);
                }

                // 4. WRITE THE MFRA CHEAT SHEET (Fixes seeking on early stops!)
                const mfraBox = this.engine.demuxer.get_mfra_box();
                if (mfraBox && mfraBox.length > 0) {
                    //await this.engine.diskStream.write(mfraBox);
                    console.log(`📦 MFRA box appended (${mfraBox.length} bytes).`);
                }
            }

            // 5. Safely lock the vault
            await this.engine.diskStream.close();
            this.engine.diskStream = null;
            console.log("✅ File successfully saved and closed.");
        }

        if (onStateChange) onStateChange("stopped");
    }
}
//#endregion