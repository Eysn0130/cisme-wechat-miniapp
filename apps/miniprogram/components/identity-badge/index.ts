import { identityLabel } from "../../services/display-identity";

Component({
  options: { virtualHost: true },
  properties: {
    kind: String,
    size: { type: Number, value: 24 },
    intro: Boolean,
    decorative: Boolean
  },
  data: { mark: "", label: "" },
  observers: {
    kind(kind: string) {
      const mark = ["sharing-officer", "administrator", "official", "support"].includes(kind) ? kind : "";
      this.setData({ mark, label: identityLabel(mark) });
    }
  }
});
