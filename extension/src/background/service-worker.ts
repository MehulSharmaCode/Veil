// Minimal service worker: opens the side panel on toolbar click. Holds no agent state
// (it can be terminated at any time).

import { configureSidePanelOnActionClick, onInstalledOrStartup } from '../platform/chrome';

configureSidePanelOnActionClick();
onInstalledOrStartup(configureSidePanelOnActionClick);
