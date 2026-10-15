import { SecretInput } from '../SecretInput';
import { ExternalLink, Field, Section, TextInput } from '../ui';

export default function HuggingFaceSettings({ settings, handleChange }) {
  return (
    <Section title="HuggingFace Configuration">
      <Field label="HuggingFace Access Token" hint={<>Used for RAG embedding model downloads. Get your token from: <ExternalLink href="https://huggingface.co/settings/tokens">HuggingFace Settings</ExternalLink></>}>
        <SecretInput settingKey="HF_TOKEN" value={settings.HF_TOKEN} onChange={(e) => handleChange('HF_TOKEN', e.target.value)} placeholder="hf_xxxxxxxxxxxxxxxxxxxxx" />
      </Field>
      <Field label="Embedding Model" hint={<>FastEmbed model for RAG embeddings. Default: BAAI/bge-small-en-v1.5 (384 dim, ~150MB). Browse models: <ExternalLink href="https://qdrant.github.io/fastembed/examples/Supported_Models/">Supported Models</ExternalLink></>}>
        <TextInput mono value={settings.HF_EMBEDDING_MODEL || ''} onChange={(e) => handleChange('HF_EMBEDDING_MODEL', e.target.value)} placeholder="BAAI/bge-small-en-v1.5" />
      </Field>
    </Section>
  );
}
