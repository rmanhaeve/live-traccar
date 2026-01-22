import assert from "node:assert/strict";
import { setupVisualization, updateMarker, __getVizTestState } from "../src/visualization.js";

// Minimal DOM and Leaflet stubs for the popup/button flow
global.document = {
  body: { appendChild() {} },
  documentElement: { style: { setProperty() {} } },
  querySelector() {
    return null;
  },
  createElement(tag) {
    return {
      tag,
      className: "",
      children: [],
      style: {},
      dataset: {},
      textContent: "",
      append(...children) {
        children.forEach((child) => this.appendChild(child));
      },
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener() {},
      remove() {},
      querySelector() {
        return null;
      },
    };
  },
  createElementNS() {
    return {
      setAttribute() {},
      classList: { add() {} },
      append() {},
      appendChild() {},
      setAttributeNS() {},
      textContent: "",
    };
  },
};

global.window = {
  addEventListener() {},
};

function createPopup(initialContent = "") {
  const popup = {
    content: initialContent,
    btn: null,
    setContent(c) {
      this.content = c;
      this.btn = null;
      return this;
    },
    getElement() {
      if (!this.content.includes("history-inline-btn")) return null;
      if (!this.btn) {
        this.btn = {
          dataset: {},
          listeners: [],
          addEventListener(name, handler) {
            this.listeners.push({ name, handler });
          },
        };
      }
      return {
        querySelector(selector) {
          return selector === ".history-inline-btn" ? popup.btn : null;
        },
      };
    },
    addEventListener() {},
  };
  return popup;
}

class DummyMarker {
  constructor() {
    this.popup = null;
    this.handlers = {};
  }
  setLatLng() {}
  bringToFront() {}
  setStyle() {}
  getPopup() {
    return this.popup;
  }
  bindPopup(content) {
    this.popup = createPopup(content);
    return this.popup;
  }
  off(name) {
    delete this.handlers[name];
  }
  on(name, handler) {
    this.handlers[name] = handler;
  }
  trigger(name) {
    if (this.handlers[name]) this.handlers[name]();
  }
}

global.L = {
  polyline() {
    return {
      addTo() {
        return this;
      },
      setLatLngs() {},
    };
  },
};

// Set up visualization state with stubs
const marker = new DummyMarker();
setupVisualization({
  config: {},
  t: (k) => k,
  getParticipantHistory: () => ({ kmEvents: [], waypointEvents: [], upcoming: [] }),
  getWaypointEta: () => null,
  getPointEta: () => null,
  isStale: () => false,
  formatDateTimeFull: () => "now",
  formatTimeLabel: () => "now",
  selectDevice: () => {},
  getSelectedDeviceId: () => 123,
  persistToggles: () => {},
  participants: new Map(),
});

const vizState = __getVizTestState();
vizState.map = {};
vizState.markers.set(123, marker);
vizState.bounds = { extend() {}, isValid: () => true };

function getBtn() {
  const popup = marker.getPopup();
  const el = popup?.getElement();
  return el?.querySelector(".history-inline-btn") || null;
}

// After position updates, the inline history button should stay clickable even when popup content refreshes
const basePosition = {
  latitude: 0,
  longitude: 0,
  deviceTime: new Date().toISOString(),
};

const movedPosition = {
  ...basePosition,
  latitude: 1,
  longitude: 1,
  speed: 0,
  deviceTime: new Date(Date.now() + 1000).toISOString(),
};

const baseParticipant = {
  id: 123,
  name: "Participant 123",
  isStale: false,
  speedKph: 0,
  progress: { point: { lat: 1, lng: 2 }, distanceAlong: 0, elevation: null, endpoint: null, offtrack: false },
  position: basePosition,
};

const movedParticipant = {
  ...baseParticipant,
  position: movedPosition,
};

updateMarker(baseParticipant);
let btn = getBtn();
assert(btn, "history button should exist after first update");
assert.equal(btn.dataset.bound, "1", "history button should be bound after first update");
assert(btn.listeners?.length === 1, "history button should have one listener after first update");

updateMarker(movedParticipant);
btn = getBtn();
assert(btn, "history button should still exist after movement");
assert.equal(btn.dataset.bound, "1", "history button should remain bound after movement");
assert(btn.listeners?.length === 1, "history button should keep listener after movement");

console.log("visualization history button test passed");
