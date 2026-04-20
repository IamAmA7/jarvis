/**
 * useWebHID
 *
 * Thin wrapper around `navigator.hid` to support a push-to-talk or
 * start/stop button on an external USB device (foot pedal, jog dial,
 * programmable keypad, etc.).
 *
 * We listen for generic input reports. Any non-zero byte is treated as
 * "button pressed" and the previous state as "released" — enough to support
 * the overwhelming majority of simple input devices. For anything more
 * sophisticated users can map keys with the device vendor's own software
 * and rely on the keyboard shortcut (future iteration).
 *
 * The browser requires a user gesture to call `requestDevice`, so we expose
 * a `connect()` callback instead of auto-connecting. Previously-granted
 * devices reconnect automatically on page load.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureError, track } from '../lib/telemetry';

export interface WebHIDState {
  supported: boolean;
  deviceName: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

interface Options {
  enabled: boolean;
  onButtonPress: () => void;
}

// Minimal structural types — we don't want to pull in @types/w3c-web-hid.
interface MinimalHIDDevice {
  opened: boolean;
  productName?: string;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'inputreport', handler: (e: HIDInputEvent) => void): void;
  removeEventListener(type: 'inputreport', handler: (e: HIDInputEvent) => void): void;
}
interface HIDInputEvent {
  data: DataView;
  reportId: number;
}
interface MinimalHID {
  requestDevice(opts: { filters: Array<Record<string, unknown>> }): Promise<MinimalHIDDevice[]>;
  getDevices(): Promise<MinimalHIDDevice[]>;
}

function hid(): MinimalHID | null {
  return (navigator as unknown as { hid?: MinimalHID }).hid ?? null;
}

export function useWebHID({ enabled, onButtonPress }: Options): WebHIDState {
  const [device, setDevice] = useState<MinimalHIDDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef(onButtonPress);
  const lastStateRef = useRef<boolean>(false);

  useEffect(() => {
    handlerRef.current = onButtonPress;
  }, [onButtonPress]);

  const supported = typeof navigator !== 'undefined' && 'hid' in navigator;

  // Try to reconnect to any previously-authorised device when the feature is enabled.
  useEffect(() => {
    if (!enabled || !supported) return;
    const api = hid();
    if (!api) return;
    void (async () => {
      try {
        const devices = await api.getDevices();
        if (devices.length > 0) await attachDevice(devices[0]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'HID reconnect failed');
      }
    })();
    // Intentionally depend only on `enabled` so we don't loop on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, supported]);

  const onInput = useCallback((e: HIDInputEvent) => {
    let pressed = false;
    const view = e.data;
    for (let i = 0; i < view.byteLength; i++) {
      if (view.getUint8(i) !== 0) {
        pressed = true;
        break;
      }
    }
    if (pressed && !lastStateRef.current) {
      track('hid:button_press');
      try {
        handlerRef.current();
      } catch (err) {
        captureError(err, { where: 'useWebHID.onInput' });
      }
    }
    lastStateRef.current = pressed;
  }, []);

  const attachDevice = useCallback(
    async (d: MinimalHIDDevice) => {
      try {
        if (!d.opened) await d.open();
        d.addEventListener('inputreport', onInput);
        setDevice(d);
        setError(null);
        track('hid:connected', { product: d.productName ?? 'unknown' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open HID device');
      }
    },
    [onInput],
  );

  const connect = useCallback(async () => {
    const api = hid();
    if (!api) {
      setError('WebHID не поддерживается в этом браузере');
      return;
    }
    try {
      const chosen = await api.requestDevice({ filters: [] });
      if (chosen.length === 0) return;
      await attachDevice(chosen[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'HID request failed');
    }
  }, [attachDevice]);

  const disconnect = useCallback(async () => {
    if (!device) return;
    try {
      device.removeEventListener('inputreport', onInput);
      if (device.opened) await device.close();
    } finally {
      setDevice(null);
      track('hid:disconnected');
    }
  }, [device, onInput]);

  useEffect(
    () => () => {
      if (device) {
        device.removeEventListener('inputreport', onInput);
        if (device.opened) void device.close();
      }
    },
    [device, onInput],
  );

  return {
    supported,
    deviceName: device?.productName ?? null,
    error,
    connect,
    disconnect,
  };
}
