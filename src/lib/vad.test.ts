import { describe, expect, it } from 'vitest';
import { EnergyVad, rmsFromTimeDomain } from './vad';

describe('rmsFromTimeDomain', () => {
  it('returns 0 for an empty buffer', () => {
    expect(rmsFromTimeDomain(new Float32Array())).toBe(0);
  });

  it('matches the textbook RMS for a constant signal', () => {
    const buf = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(rmsFromTimeDomain(buf)).toBeCloseTo(0.5);
  });

  it('treats a symmetric wave equivalent to its amplitude scaled', () => {
    const buf = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(rmsFromTimeDomain(buf)).toBeCloseTo(0.5);
  });
});

describe('EnergyVad', () => {
  it('rejects anything below the absolute floor regardless of noise floor', () => {
    const vad = new EnergyVad({ absoluteFloor: 0.01, speechMultiplier: 2 });
    expect(vad.isSpeech(0.005)).toBe(false);
  });

  it('calls a level above the noise floor × multiplier speech', () => {
    const vad = new EnergyVad({ absoluteFloor: 0.001, speechMultiplier: 2 });
    // start with a low noise floor — default is 0.01
    expect(vad.isSpeech(0.05)).toBe(true);
  });

  it('adapts the noise floor toward quieter observations quickly', () => {
    const vad = new EnergyVad();
    const before = vad.getNoiseFloor();
    for (let i = 0; i < 50; i++) vad.observe(0.001);
    expect(vad.getNoiseFloor()).toBeLessThan(before);
  });

  it('resists having its floor pumped up by loud speech', () => {
    const vad = new EnergyVad();
    const before = vad.getNoiseFloor();
    // A burst of loud frames should barely move the floor thanks to the slow EMA
    for (let i = 0; i < 10; i++) vad.observe(0.9);
    expect(vad.getNoiseFloor() - before).toBeLessThan(0.05);
  });
});
