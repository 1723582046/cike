'use strict';
/**
 * WebRTC leak prevention.
 *
 * When a SOCKS5 proxy with auth is used, Chromium routes through a local
 * HTTP forwarder (TCP-only). WebRTC's UDP traffic cannot go through it and
 * would leak the real IP via STUN. In that case, or when the profile sets
 * webrtc='disabled', we neuter RTCPeerConnection entirely.
 *
 * The stub is masked to look native via the shared function-masking setup.
 */

function webrtcBlockScript() {
  return `(() => {
    // Only block if not already blocked
    if (window.__lfb_webrtc_blocked) return;
    window.__lfb_webrtc_blocked = true;

    const StubPeerConnection = function() {
      // Return a minimal stub that never gathers ICE candidates
      return {
        createOffer: () => Promise.reject(new Error('WebRTC disabled')),
        createAnswer: () => Promise.reject(new Error('WebRTC disabled')),
        setLocalDescription: () => Promise.reject(new Error('WebRTC disabled')),
        setRemoteDescription: () => Promise.reject(new Error('WebRTC disabled')),
        addIceCandidate: () => Promise.reject(new Error('WebRTC disabled')),
        close: () => {},
        getStats: () => Promise.resolve(new Map()),
        // Event handlers (no-ops)
        onicecandidate: null,
        ontrack: null,
        onconnectionstatechange: null,
        // Properties
        iceConnectionState: 'closed',
        connectionState: 'closed',
        signalingState: 'closed',
      };
    };

    // Mask as native (uses the shared __lfb_masks registry if available)
    try {
      if (window.__lfb_masks) {
        window.__lfb_masks.set(StubPeerConnection, {
          name: 'RTCPeerConnection',
          str: 'function RTCPeerConnection() { [native code] }',
        });
      } else {
        Object.defineProperty(StubPeerConnection, 'name', { value: 'RTCPeerConnection' });
        StubPeerConnection.toString = () => 'function RTCPeerConnection() { [native code] }';
      }
    } catch {}

    Object.defineProperty(window, 'RTCPeerConnection', {
      get: () => StubPeerConnection,
      configurable: true,
    });
    // Also block the prefixed version
    try {
      Object.defineProperty(window, 'webkitRTCPeerConnection', {
        get: () => StubPeerConnection,
        configurable: true,
      });
    } catch {}
  })();`;
}

module.exports = { webrtcBlockScript };
