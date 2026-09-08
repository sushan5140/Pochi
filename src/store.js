const Store = require('electron-store');

const store = new Store({
  name: 'pochi-state',
  defaults: {
    sessionStart: Date.now(),
    lastWaterReminderAt: null,
    waterEscalation: 0,
    lastFoodReminderAt: null,
    foodEscalation: 0,
    lastBreakReminderAt: null,
    breakEscalation: 0,
    batteryLowSince: null,
    batteryIgnoredChecks: 0,
    lateNightStart: null,
    lastEntertainmentReminderAt: null,
    entertainmentEscalation: 0,
    friendship: 0
  }
});

// Fresh session clock every launch — the nag timers below are about the
// current sitting, not lifetime totals.
store.set('sessionStart', Date.now());

module.exports = store;
