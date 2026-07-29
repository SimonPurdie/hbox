interface ColorisOptions {
  el: string | HTMLElement | HTMLElement[];
  alpha?: boolean;
  swatches?: string[];
}

declare function Coloris(options: ColorisOptions): void;
