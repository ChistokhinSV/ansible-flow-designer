// AFS-188: a step's Details that only show (a viewer, Run mode, Code mode outside Binding). The Data
// tab is not a disabled fieldset, so its rows still open to say where a value comes from; its
// editors read this instead and offer nothing that would be refused.
import { createContext, useContext } from 'react';

export const DetailsReadOnly = createContext(false);

export const useDetailsReadOnly = (): boolean => useContext(DetailsReadOnly);
