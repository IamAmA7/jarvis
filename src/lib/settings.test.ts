import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings';

describe('settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults on a fresh browser', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through save/load', () => {
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      model: 'claude-opus-4-6',
      language: 'en',
      pushToTalkEnabled: true,
    };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it('falls back to the default model when an unknown value is on disk', () => {
    localStorage.setItem(
      'jarvis.settings.v2',
      JSON.stringify({ model: 'gpt-4', language: 'ru' }),
    );
    expect(loadSettings().model).toBe(DEFAULT_SETTINGS.model);
  });

  it('normalises transcriptionEngine: unknown values → whisper', () => {
    localStorage.setItem(
      'jarvis.settings.v2',
      JSON.stringify({ transcriptionEngine: 'wav2vec' }),
    );
    expect(loadSettings().transcriptionEngine).toBe('whisper');
  });

  it('survives a corrupt localStorage payload', () => {
    localStorage.setItem('jarvis.settings.v2', 'not-json{{{');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('clearSettings removes the stored blob', () => {
    saveSettings({ ...DEFAULT_SETTINGS, language: 'uk' });
    clearSettings();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
