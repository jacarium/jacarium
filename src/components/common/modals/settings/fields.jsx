/**
 * Field and Toggle for the Integrations / AI Providers panels: the shared
 * primitives (src/components/ui/primitives.jsx) with `forKey` - the
 * settings key the control edits. The label is the key's entry in
 * settings/fieldCatalog.js (the one definition of these labels, which the
 * copy sheet uses too; a `label` prop overrides it), and the dialog tags
 * where the value comes from in the My account scope ("your account" /
 * "everyone" / "not set", settings/provenanceContext.js). The other
 * primitives come from ./ui as before.
 */
import { Field as BaseField, Toggle as BaseToggle } from '../../../ui/primitives';
import { useSettingsProvenance } from './provenanceContext';
import { settingsFieldLabel } from './fieldCatalog';

function ProvenanceTag({ tag }) {
  if (!tag) return null;
  const { tag: text, detail } = typeof tag === 'string' ? { tag, detail: null } : tag;
  return <span className="sc-provenance ml-2 text-[11px] font-normal text-os-text-muted" data-testid="provenance-tag" data-provenance={text}>{text}{detail ? <>: <span className="font-mono">{detail}</span></> : null}</span>;
}

export function Field({ forKey, label, ...props }) {
  const { tagFor } = useSettingsProvenance();
  const tag = forKey ? tagFor(forKey) : null;
  const text = label ?? (forKey ? settingsFieldLabel(forKey) : undefined);
  return <BaseField {...props} label={tag ? <>{text}<ProvenanceTag tag={tag} /></> : text} />;
}

export function Toggle({ forKey, label, ...props }) {
  const { tagFor } = useSettingsProvenance();
  const tag = forKey ? tagFor(forKey) : null;
  const text = label ?? (forKey ? settingsFieldLabel(forKey) : undefined);
  return <BaseToggle {...props} label={tag ? <>{text}<ProvenanceTag tag={tag} /></> : text} />;
}
