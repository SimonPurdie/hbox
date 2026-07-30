import { ApiClient } from "./api-client.js";
import { requiredElement } from "./dom.js";
import { interfaceThemeFor } from "./model.js";

export class PreferencesView {
  readonly button = requiredElement<HTMLButtonElement>("open-config");
  readonly menu = requiredElement<HTMLElement>("config-menu");
  private readonly restartButton =
    requiredElement<HTMLButtonElement>("restart-server");
  private readonly colorInput =
    requiredElement<HTMLInputElement>("interface-color");

  constructor(
    private readonly api: ApiClient,
    private readonly beforeOpen: () => void,
  ) {
    Coloris({
      el: "#interface-color",
      alpha: false,
      swatches: [],
    });
    this.button.addEventListener("click", () => this.toggle());
    this.restartButton.addEventListener(
      "click",
      () => void this.restartServer(),
    );
    this.colorInput.addEventListener("input", () => {
      if (isColor(this.colorInput.value)) {
        applyInterfaceColor(this.colorInput.value);
      }
    });
    this.colorInput.addEventListener("change", () => {
      if (isColor(this.colorInput.value)) {
        void this.saveColor(this.colorInput.value);
      } else {
        void this.load();
      }
    });
    void this.load();
  }

  get isOpen(): boolean {
    return !this.menu.hidden;
  }

  toggle(): void {
    const shouldOpen = this.menu.hidden;
    if (shouldOpen) {
      this.beforeOpen();
    }
    this.menu.hidden = !shouldOpen;
    this.button.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      this.restartButton.focus();
    }
  }

  close(): void {
    this.menu.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }

  private async load(): Promise<void> {
    try {
      const preferences = await this.api.preferences();
      this.colorInput.value = preferences.interfaceColor;
      this.colorInput.dispatchEvent(
        new Event("input", { bubbles: true }),
      );
    } catch (error) {
      console.error(error);
    }
  }

  private async saveColor(color: string): Promise<void> {
    try {
      await this.api.savePreferences({ interfaceColor: color });
    } catch (error) {
      console.error(error);
      await this.load();
    }
  }

  private async restartServer(): Promise<void> {
    this.restartButton.disabled = true;
    try {
      const current = await this.api.restart();
      await this.waitForServer(current.instanceId);
      window.location.reload();
    } catch (error) {
      console.error(error);
      this.restartButton.disabled = false;
    }
  }

  private async waitForServer(previousInstanceId: string): Promise<void> {
    await delay(300);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const status = await this.api.status();
        if (status.instanceId !== previousInstanceId) {
          return;
        }
      } catch {
        // The old listener is closed while its replacement starts.
      }
      await delay(250);
    }
    throw new Error("HBOX did not return after restart.");
  }
}

function applyInterfaceColor(color: string): void {
  const theme = interfaceThemeFor(color);
  const root = document.documentElement.style;
  root.setProperty("--interface-color", color);
  root.setProperty("--interface-foreground", theme.foreground);
  root.setProperty("--interface-icon-filter", theme.iconFilter);
  root.setProperty("--interface-shadow-color", theme.shadowColor);
  root.setProperty("color-scheme", theme.colorScheme);
}

function isColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
