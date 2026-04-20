/**
 * Simple energy-based voice activity detection.
 *
 * We don't need a neural VAD here — MediaRecorder timeslicing gives us small
 * chunks, and all we want is "is this chunk worth sending to Whisper?"
 * We measure RMS amplitude from an AnalyserNode over the capture window and
 * compare it to a dynamic noise floor.
 */
export interface VadParams {
  /** Anything below this RMS (0..1) is definitely silence. */
  absoluteFloor: number;
  /** Multiplier over the running noise floor required to count as speech. */
  speechMultiplier: number;
}

export const DEFAULT_VAD: VadParams = {
  absoluteFloor: 0.008,
  speechMultiplier: 2.2,
};

export class EnergyVad {
  private noiseFloor = 0.01;
  private readonly params: VadParams;

  constructor(params: VadParams = DEFAULT_VAD) {
    this.params = params;
  }

  /** Feed the RMS level of the latest audio frame (0..1). Updates noise floor. */
  observe(rms: number): void {
    // Slow EMA toward quieter samples only — so loud speech doesn't inflate the floor.
    if (rms < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * 0.92 + rms * 0.08;
    } else {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    }
  }

  /** Should we send the chunk that corresponds to an average RMS of `avgRms`? */
  isSpeech(avgRms: number): boolean {
    if (avgRms < this.params.absoluteFloor) return false;
    return avgRms > this.noiseFloor * this.params.speechMultiplier;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }
}

/** Compute RMS (0..1) from a Float32 time-domain sample buffer. */
export function rmsFromTimeDomain(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
