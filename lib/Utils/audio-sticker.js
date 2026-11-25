/**
 * Audio Sticker (experimental)
 *
 * Builds a WhatsApp "audio sticker": a WebP sticker combined with an
 * Ogg/Opus audio clip. Both media are encrypted and uploaded separately and
 * then embedded in a custom protobuf field (134) that is not part of the
 * bundled WAProto definitions, so it is appended to the encoded Message as raw
 * bytes.
 *
 * Original implementation: ©iEnz
 *
 * Requirements: FFmpeg in PATH (only when the input is not already Ogg/Opus
 * audio and/or WebP image).
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { proto } from '../../WAProto/index.js';
import { encryptedStream } from './messages-media.js';
const OGG_OPUS_MIMETYPE = 'audio/ogg; codecs=opus';
const DEFAULT_MEDIA_HOST = 'https://mmg.whatsapp.net';
/** Symbol used to attach raw protobuf fields to a Message object */
export const RAW_PROTO_FIELDS = Symbol.for('baileys.rawProtoFields');
const PATCH_MARK = Symbol.for('baileys.rawProtoFields.patched');
/**
 * Make `proto.Message.encode` append the raw fields stored under
 * `RAW_PROTO_FIELDS`. The patch is installed once, is idempotent and is a no-op
 * for any message without raw fields. It also applies to nested messages
 * (e.g. inside deviceSentMessage), because protobufjs calls
 * `proto.Message.encode` for those too.
 */
export const installRawFieldEncoder = () => {
    const current = proto.Message.encode;
    if (current[PATCH_MARK])
        return;
    const patched = function (msg, w) {
        const out = current.call(this, msg, w);
        const raw = msg?.[RAW_PROTO_FIELDS];
        if (raw) {
            for (const [field, body] of raw) {
                out.uint32(field * 8 + 2).bytes(body);
            }
        }
        return out;
    };
    patched[PATCH_MARK] = true;
    proto.Message.encode = patched;
};
const varint = (n) => {
    const out = [];
    while (n > 127) {
        out.push((n % 128) | 128);
        n = Math.floor(n / 128);
    }
    out.push(n);
    return Buffer.from(out);
};
/** length-delimited protobuf field */
const ld = (field, body) => Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
const runFFmpeg = (args, input) => new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => reject(new Error(`failed to run ffmpeg: ${e.message}`)));
    p.on('close', code => {
        if (code !== 0)
            return reject(new Error(`ffmpeg exited with code ${code}: ${err.slice(-500)}`));
        resolve(Buffer.concat(out));
    });
    p.stdin.on('error', () => { });
    p.stdin.end(input);
});
const toOpus = (input) => runFFmpeg([
    '-v', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-map_metadata', '-1',
    '-c:a', 'libopus',
    '-b:a', '64k',
    '-ar', '48000',
    '-ac', '1',
    '-f', 'ogg',
    'pipe:1'
], input);
const toWebp = (input) => runFFmpeg([
    '-v', 'error',
    '-i', 'pipe:0',
    '-frames:v', '1',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-c:v', 'libwebp',
    '-f', 'webp',
    'pipe:1'
], input);
const isWebp = (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
const isOgg = (b) => b.length > 4 && b.toString('ascii', 0, 4) === 'OggS';
/** Reads width/height/animation flag from a WebP buffer */
export const parseWebp = (b) => {
    if (b.length < 30 || !isWebp(b)) {
        throw new Error('Invalid WebP');
    }
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
        return {
            width: b.readUInt16LE(26) & 0x3fff,
            height: b.readUInt16LE(28) & 0x3fff,
            isAnimated: false
        };
    }
    if (chunk === 'VP8L') {
        return {
            width: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
            height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
            isAnimated: false
        };
    }
    if (chunk === 'VP8X') {
        return {
            width: 1 + b.readUIntLE(24, 3),
            height: 1 + b.readUIntLE(27, 3),
            isAnimated: (b[20] & 2) !== 0
        };
    }
    throw new Error('Unsupported WebP chunk');
};
/** Resolves a Buffer | { url } | { stream } | file path | http(s) url into a Buffer */
const toBuffer = async (src) => {
    if (Buffer.isBuffer(src))
        return src;
    if (src instanceof Uint8Array)
        return Buffer.from(src);
    if (src && typeof src === 'object') {
        if (src.url)
            return toBuffer(src.url.toString());
        if (src.stream) {
            const chunks = [];
            for await (const c of src.stream)
                chunks.push(Buffer.from(c));
            return Buffer.concat(chunks);
        }
    }
    if (typeof src === 'string') {
        if (/^https?:\/\//i.test(src)) {
            const res = await fetch(src);
            if (!res.ok)
                throw new Error(`failed to fetch ${src}: HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        }
        return fs.readFile(src);
    }
    throw new TypeError('unsupported media source, expected Buffer, file path, URL or { url } / { stream }');
};
/** Encrypts `plain` with the media keys of `kind` and uploads it */
const encryptAndUpload = async (plain, kind, upload) => {
    const { mediaKey, encFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(plain, kind);
    try {
        const res = await upload(encFilePath, {
            fileEncSha256B64: fileEncSha256.toString('base64'),
            mediaType: kind
        });
        if (!res?.directPath) {
            throw new Error(`${kind} upload returned no directPath`);
        }
        return {
            url: res.mediaUrl || `${DEFAULT_MEDIA_HOST}${res.directPath}`,
            directPath: res.directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: Math.floor(Date.now() / 1000)
        };
    }
    finally {
        fs.unlink(encFilePath).catch(() => { });
    }
};
const mediaDomainInfo = (mediaKey) => ld(74, Buffer.concat([Buffer.from([0x08, 0x01]), ld(2, mediaKey)]));
/**
 * Generates the (not yet relayed) audio sticker message.
 *
 * @param content.audio   audio source (Buffer, path, URL, { url } or { stream }). Converted to Ogg/Opus with FFmpeg unless already Ogg
 * @param content.sticker image source (same source types). Converted to a 512x512 WebP with FFmpeg unless already WebP
 * @param upload          `sock.waUploadToServer`
 * @returns the Message to pass to `relayMessage`, plus audio / sticker details
 */
export const generateAudioStickerMessage = async ({ audio, sticker }, upload) => {
    if (!audio)
        throw new TypeError('audio is required');
    if (!sticker)
        throw new TypeError('sticker is required');
    const audioInput = await toBuffer(audio);
    const stickerInput = await toBuffer(sticker);
    const audioBuf = isOgg(audioInput) ? audioInput : await toOpus(audioInput);
    const stickerBuf = isWebp(stickerInput) ? stickerInput : await toWebp(stickerInput);
    const webp = parseWebp(stickerBuf);
    const [a, s] = await Promise.all([
        encryptAndUpload(audioBuf, 'audio', upload),
        encryptAndUpload(stickerBuf, 'sticker', upload)
    ]);
    const audioBytes = Buffer.concat([
        Buffer.from(proto.Message.AudioMessage.encode(proto.Message.AudioMessage.create({
            url: a.url,
            mimetype: OGG_OPUS_MIMETYPE,
            fileSha256: a.fileSha256,
            fileEncSha256: a.fileEncSha256,
            fileLength: a.fileLength,
            mediaKey: a.mediaKey,
            directPath: a.directPath,
            mediaKeyTimestamp: a.mediaKeyTimestamp
        })).finish()),
        ld(17, mediaDomainInfo(a.mediaKey))
    ]);
    const stickerBase = Buffer.concat([
        Buffer.from(proto.Message.StickerMessage.encode(proto.Message.StickerMessage.create({
            url: s.url,
            fileSha256: s.fileSha256,
            fileEncSha256: s.fileEncSha256,
            mediaKey: s.mediaKey,
            mimetype: 'image/webp',
            height: webp.height,
            width: webp.width,
            directPath: s.directPath,
            fileLength: s.fileLength,
            mediaKeyTimestamp: s.mediaKeyTimestamp,
            isAnimated: webp.isAnimated,
            stickerSentTs: Date.now()
        })).finish()),
        ld(17, Buffer.concat([mediaDomainInfo(s.mediaKey), ld(82, varint(13001))]))
    ]);
    const futureProofBody = ld(1, ld(26, Buffer.concat([stickerBase, ld(26, audioBytes)])));
    installRawFieldEncoder();
    const message = proto.Message.create({
        messageContextInfo: {
            messageSecret: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
        }
    });
    message[RAW_PROTO_FIELDS] = [[134, futureProofBody]];
    return {
        message,
        audio: { mimetype: OGG_OPUS_MIMETYPE, size: audioBuf.length },
        sticker: { mimetype: 'image/webp', width: webp.width, height: webp.height }
    };
};
