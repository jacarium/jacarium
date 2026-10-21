import { useState } from 'react';
import DefaultAISettings from './ai-providers/DefaultAISettings';
import OpenAISettings from './ai-providers/OpenAISettings';
import AnthropicSettings from './ai-providers/AnthropicSettings';
import GeminiSettings from './ai-providers/GeminiSettings';
import CustomAISettings from './ai-providers/CustomAISettings';
import SSHAISettings from './ai-providers/SSHAISettings';
import PrivacySettings from './ai-providers/PrivacySettings';
import { SubTabs } from './ui';
import { settingsSubTabs } from './fieldCatalog';

// the sub-tabs and their titles: settings/fieldCatalog.js (one per panel below)
const TABS = settingsSubTabs('ai');

export default function AIProvidersSettings({ settings, handleChange, availableModels }) {
  const [tab, setTab] = useState('default');
  return (
    <div className="space-y-6">
      <SubTabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'default' && <DefaultAISettings settings={settings} handleChange={handleChange} availableModels={availableModels} />}
      {tab === 'openai' && <OpenAISettings settings={settings} handleChange={handleChange} />}
      {tab === 'anthropic' && <AnthropicSettings settings={settings} handleChange={handleChange} />}
      {tab === 'gemini' && <GeminiSettings settings={settings} handleChange={handleChange} />}
      {tab === 'custom' && <CustomAISettings settings={settings} handleChange={handleChange} />}
      {tab === 'ssh' && <SSHAISettings settings={settings} handleChange={handleChange} />}
      {tab === 'privacy' && <PrivacySettings />}
    </div>
  );
}
