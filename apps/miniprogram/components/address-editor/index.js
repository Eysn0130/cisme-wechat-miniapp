Component({
  options: { styleIsolation: "isolated" },
  properties: {
    draft: { type: Object, value: {} },
    busy: { type: Boolean, value: false },
    parsing: { type: Boolean, value: false },
    quickInput: { type: String, value: "" },
    parseStatus: { type: String, value: "idle" },
    parseSummary: { type: String, value: "" },
    parseWarnings: { type: Array, value: [] },
    fieldErrors: { type: Object, value: {} },
    conflict: { type: Boolean, value: false },
    canSaveAsNew: { type: Boolean, value: true }
  },
  methods: {
    emitQuickInput(event) { this.triggerEvent("quickinput", { value: event.detail.value }); },
    emitField(event) { this.triggerEvent("fieldchange", { field: event.currentTarget.dataset.field, value: event.detail.value }); },
    emitRegion(event) { this.triggerEvent("regionchange", event.detail); },
    emitLabel(event) { this.triggerEvent("labelchange", { label: event.currentTarget.dataset.label }); },
    emitDefault(event) { this.triggerEvent("defaultchange", { value: event.detail.value }); },
    emitSimple(event) { this.triggerEvent(event.currentTarget.dataset.action); },
    emitSubmit() { this.triggerEvent("save"); }
  }
});
