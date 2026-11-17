const paths = {
  arrow: "M4 12h16m-6-6 6 6-6 6",
  diagonal: "M6 18 18 6M6 6h12v12",
  chevron: "m8 10 4 4 4-4",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 4 4L19 6",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  workflow: "M6 7v4a2 2 0 0 0 2 2h8a2 2 0 0 1 2 2v2M6 11v6M3 3h6v4H3zM3 17h6v4H3zM15 17h6v4h-6z",
  file: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6",
  copy: "M9 8h11v13H9zM5 16H3V3h11v2",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  briefcase: "M8 6V3h8v3M3 6h18v15H3V6Zm0 6a24 24 0 0 0 18 0M10 12v3h4v-3",
  calendar: "M4 5h16v16H4V5Zm3-3v6m10-6v6M4 10h16m-12 4h2m4 0h2m-8 3h2",
  terminal: "m5 7 4 5-4 5m7 0h7",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  globe: "M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Zm9 9a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
};

export function Icon({ name = "arrow", size = 20, className = "" }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.arrow} /></svg>;
}

export function BrandMark({ size = 28 }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 46 42" fill="currentColor" aria-hidden="true"><path d="m4 13 14-7 14 7-14 7Zm0 10 14 7 14-7v6l-14 7L4 29ZM22 6h20l-6 6H22Zm5 9h11l-6 5h-5Z" /></svg>;
}
