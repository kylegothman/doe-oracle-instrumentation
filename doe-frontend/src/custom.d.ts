declare namespace JSX {
  interface IntrinsicElements {
    'gen-search-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      configId?: string;
      triggerId?: string;
      // Add other props if needed
    };
  }
} 