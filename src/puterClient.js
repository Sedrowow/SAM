const { init } = require("@heyputer/puter.js/src/init.cjs");

function ensurePuterNodePolyfills() {
  if (typeof globalThis.Event !== "function") {
    globalThis.Event = class Event {
      constructor(type, params = {}) {
        this.type = type;
        this.bubbles = Boolean(params.bubbles);
        this.cancelable = Boolean(params.cancelable);
        this.composed = Boolean(params.composed);
      }
    };
  }

  if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent extends globalThis.Event {
      constructor(type, params = {}) {
        super(type, params);
        this.detail = params.detail;
      }
    };
  }
}

function createPuterClient(authToken) {
  if (!authToken) {
    throw new Error("Missing Puter auth token");
  }

  ensurePuterNodePolyfills();

  return init(authToken);
}

module.exports = {
  createPuterClient
};
