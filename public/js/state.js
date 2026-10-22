// App-wide state shared by the page modules.
import { defaultSpec } from "./views.js";

export const S = {
  me: null,
  requests: [], actions: [], views: [], profiles: [],
  inventory: [], moves: [], emails: [], docs: [],
  route: "dashboard",
  reqFilter: { q: "", sub: "", status: "" },
  actionFilter: "",
  builder: { prompt: "", spec: defaultSpec(), viewId: null, pinned: false, busy: false, note: "", source: "" },
  draft: { photos: [], sub: "" },
  modalId: null,
  inv: { sub: "", type: "", q: "", lowOnly: false },
  imp: null,
  emailTab: "New",
};

export const isManager = () => S.me?.role === "manager";
export const ROLE_LABEL = { manager: "Manager", owner_relations: "Owner Relations" };

// Filled in by app.js so page modules can trigger a re-render or open a ticket.
export const hooks = { render: () => {}, openRequest: () => {}, closeModal: () => {} };
