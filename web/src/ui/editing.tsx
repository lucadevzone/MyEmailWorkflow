import { createContext, useContext, useState, type ReactNode } from 'react';

/** Modalità gestione (S6): barra dei progetti o barra contatti, mai entrambe insieme. */
export type EditingMode = null | 'projects' | 'rail';

const EditingContext = createContext<{ mode: EditingMode; setMode: (m: EditingMode) => void }>({ mode: null, setMode: () => {} });

export function EditingProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<EditingMode>(null);
  return <EditingContext.Provider value={{ mode, setMode }}>{children}</EditingContext.Provider>;
}

export const useEditing = () => useContext(EditingContext);

/** Riquadro che spiega la modalità, sopra il contenuto attenuato. */
export function EditingDimmer() {
  return (
    <div className="pm-dimmer" aria-hidden="false">
      <div className="pm-dimmer__card">
        <div style={{ fontWeight: 600 }}>Modalità gestione</div>
        <p>
          Trascina dalla maniglia per riordinare; il segno meno rimuove la voce. Per le persone e i gruppi significa toglierli da
          questo progetto, non eliminare il contatto. Da smistare, News e Tutti sono fissi. Le modifiche si applicano con Fine.
        </p>
      </div>
      <div className="pm-dimmer__ghost" aria-hidden="true" />
      <div className="pm-dimmer__ghost" aria-hidden="true" />
      <div className="pm-dimmer__ghost" aria-hidden="true" />
    </div>
  );
}
