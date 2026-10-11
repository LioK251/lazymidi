"""Project adapter: decode all supported media without an MP3 intermediate.

The upstream CLI hardcodes an MP3 decoder and 16-bit normalization. Delegate
model loading/inference to it, replacing only its audio reader in this process.
"""
import numpy as np


def read_audio(path, normalize=True):
    # The app decodes float WAV in a tracked, cancellable FFmpeg process first.
    from scipy.io import wavfile
    rate, samples = wavfile.read(path)
    if samples.dtype.kind != 'f':
        raise ValueError('The Transkun adapter expects a float PCM WAV')
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[:, None]
    if not samples.size:
        raise ValueError('Input contains no audio samples')
    if not np.isfinite(samples).all():
        raise ValueError('Input contains invalid audio samples')
    if not normalize:
        samples *= 32768
    return rate, samples


def main():
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    from transkun import transcribe
    transcribe.readAudio = read_audio
    transcribe.main()


if __name__ == '__main__':
    main()
