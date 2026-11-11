import React from 'react';
import { Chakra, HasNativeSelect } from '../lib/host';

/* ------------------------------------------------------------------ */
/* Widget principal                                                    */
/* ------------------------------------------------------------------ */

export const Select = ({ value, onChange, options, placeholder, title }) => {
  // options : chaines ou {value, label} ; placeholder absent = pas d'option vide.
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const field = norm.map((o) => (
    <option key={o.value} value={o.value}>{o.label}</option>
  ));
  if (!HasNativeSelect) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} title={title} style={{ height: '32px' }}>
        {placeholder && <option value="">{placeholder}</option>}
        {field}
      </select>
    );
  }
  return (
    <Chakra.NativeSelectRoot size="sm" width="auto" minW="120px" title={title}>
      <Chakra.NativeSelectField placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}>
        {field}
      </Chakra.NativeSelectField>
    </Chakra.NativeSelectRoot>
  );
};
