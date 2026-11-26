import {
  AudioSample, AudioSampleSource, BufferTarget, CanvasSource,
  Output, QUALITY_HIGH, Quality, WebMOutputFormat, canEncodeAudio, canEncodeVideo,
} from "mediabunny";

const frameRate = 30;
const estimatedVideoBitrate = 5_000_000;
const audioBitrate = 128_000;
const opusSampleRate = 48_000;
const videoOptions = {
  contentHint: "detail",
  latencyMode: "quality",
} as const;
const videoQuality = {vp9: QUALITY_HIGH, vp8: new Quality({bitrate: 2_400_000})};
const audioQuality = new Quality({bitrate: audioBitrate});
const memoryBudget = 384 * 1024 ** 2;
type OfflineCodec = "vp9" | "vp8";

export async function offlineVideoCodec(width: number, height: number, duration: number, sampleRate: number): Promise<OfflineCodec | null> {
  const estimatedBytes = duration * (sampleRate * 8 + (estimatedVideoBitrate + audioBitrate) / 4);
  if (!(duration > 0 && width > 0 && height > 0) || estimatedBytes > memoryBudget || width * height * 4 > 32 * 1024 ** 2) return null;
  if (!await canEncodeAudio("opus", {numberOfChannels: 2, sampleRate: opusSampleRate, quality: audioQuality})) return null;
  for (const codec of ["vp9", "vp8"] as const) {
    if (await canEncodeVideo(codec, {width, height, frameRate, ...videoOptions, quality: videoQuality[codec]})) return codec;
  }
  return null;
}

export async function renderOfflineWebm({canvas, codec, audio, duration, signal, draw, progress}: {
  canvas: HTMLCanvasElement; codec: OfflineCodec; audio: AudioBuffer; duration: number; signal: AbortSignal;
  draw: (time: number) => void; progress: (percent: number) => void;
}) {
  // Mediabunny validates the canvas and sample types in this window's realm.
  const capture = document.createElement("canvas");
  capture.width = canvas.width;
  capture.height = canvas.height;
  const context = capture.getContext("2d", {alpha: false});
  if (!context) throw new Error("Video canvas could not be created.");
  const target = new BufferTarget();
  const output = new Output({format: new WebMOutputFormat(), target});
  const video = new CanvasSource(capture, {codec, ...videoOptions, quality: videoQuality[codec], keyFrameInterval: 4});
  const sound = new AudioSampleSource({codec: "opus", quality: audioQuality, transform: {sampleRate: opusSampleRate}});
  output.addVideoTrack(video, {frameRate});
  output.addAudioTrack(sound);
  const abort = () => { void output.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    await output.start();
    await Promise.all([
      (async () => {
        const frames = Math.ceil(duration * frameRate);
        let lastProgress = -1;
        for (let index = 0; index < frames; index++) {
          signal.throwIfAborted();
          const time = index / frameRate;
          draw(time);
          context.drawImage(canvas, 0, 0, capture.width, capture.height);
          await video.add(time, Math.min(1 / frameRate, duration - time));
          const percent = 5 * Math.floor(index / frames * 20);
          if (percent !== lastProgress) { progress(percent); lastProgress = percent; }
          if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
        }
        video.close();
      })(),
      (async () => {
        const channels = [audio.getChannelData(0), audio.getChannelData(1)];
        const sampleRate = audio.sampleRate;
        for (let start = 0; start < audio.length; start += sampleRate) {
          signal.throwIfAborted();
          const end = Math.min(start + sampleRate, audio.length);
          const data = new Float32Array(2 * (end - start));
          data.set(channels[0].subarray(start, end));
          data.set(channels[1].subarray(start, end), end - start);
          const sample = new AudioSample({data, format: "f32-planar", numberOfChannels: 2, sampleRate, timestamp: start / sampleRate});
          try { await sound.add(sample); } finally { sample.close(); }
        }
        sound.close();
      })(),
    ]);
    signal.throwIfAborted();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error("No video was produced.");
    return new Blob([target.buffer], {type: "video/webm"});
  } finally {
    signal.removeEventListener("abort", abort);
    if (output.state !== "finalized") await output.cancel().catch(() => {});
  }
}
