# How to Add a New Tool

Simple step-by-step guide to add a new tool to Jacarium.

## Steps

### 1. Create Tool Component

Create a new file: `src/components/features/tools/YourToolName.jsx`

```jsx
import { useState } from 'react';
import { YourIcon } from 'lucide-react';

export default function YourToolName() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');

  const handleProcess = () => {
    // Your tool logic here
    setOutput(input);
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <YourIcon size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            Your Tool Name
          </h3>
        </div>

        {/* Input */}
        <div>
          <label className="block text-sm font-medium text-os-text-primary mb-2">
            Input
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter input..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded text-os-text-primary text-sm resize-none focus:outline-none focus:ring-2 focus:ring-os-blue placeholder-os-text-muted"
          />
        </div>

        {/* Action Button */}
        <button
          onClick={handleProcess}
          disabled={!input}
          className="px-4 py-2 bg-os-blue text-white text-sm font-medium rounded hover:bg-os-blue-hover disabled:opacity-50 transition-colors"
        >
          Process
        </button>

        {/* Output */}
        <div>
          <label className="block text-sm font-medium text-os-text-primary mb-2">
            Output
          </label>
          <textarea
            value={output}
            readOnly
            placeholder="Output will appear here..."
            className="w-full h-32 px-3 py-2 bg-os-card border border-os-border rounded text-os-text-primary text-sm resize-none placeholder-os-text-muted"
          />
        </div>
      </div>
    </div>
  );
}
```

### 2. Register Tool

Open `src/utils/tools.js`:

**Add import at the top:**
```javascript
import YourToolName from '../components/features/tools/YourToolName';
import { YourIcon } from 'lucide-react';
```

**Add tool definition to the TOOLS array:**
```javascript
const TOOLS = [
  // ... existing tools ...
  {
    id: 'your-tool-id',
    name: 'Your Tool Name',
    description: 'Brief description of what your tool does',
    category: 'Conversion', // or 'Calculate', 'Text', 'Encode/Decode', 'Generate', 'Format', 'Validate', 'Network'
    icon: YourIcon,
    component: YourToolName
  },
  // ... other tools ...
];
```

### 3. Done!

Your tool is now available in the Tools page under the specified category.

## Categories

Choose one of these categories:
- **Calculate** - Hash Calculator, SLA Calculator, Subnet Calculators
- **Conversion** - Color Converter, CSV/JSON, Time Format
- **Text** - String Utilities, Text Diff, String Analyzer
- **Encode/Decode** - Base64, URL Encoder, JWT Decoder, HTML Entities
- **Generate** - UUID, Barcode, QR Code, Lorem Ipsum, CSR
- **Format** - JSON, CSS, HTML, SQL Formatters
- **Validate** - Regex Validator, IBAN Validator, WHOIS Lookup
- **Network** - IPv4/IPv6 Calculators, URL Exploder
- **Time** - Countdown Timer, Stopwatch, Time Format Converter

## Tips

- Use existing tools as templates (check `src/components/features/tools/`)
- Follow the same layout pattern for consistency
- Use Tailwind CSS classes (see existing tools for examples)
- Use Lucide React icons from https://lucide.dev/icons/
- Test your tool before committing

## Common Patterns

### With Samples Button
See `Base64Tool.jsx` or `RegexValidatorTool.jsx` for examples with sample data

### With Mode Toggle (e.g., Encode/Decode)
See `Base64Tool.jsx` or `UrlEncoderTool.jsx` for radio button toggles

### With Copy to Clipboard
See `UuidGeneratorTool.jsx` for copy functionality

### With File Upload
See `FloatingQuiz.jsx` (AI Generated section) for file upload patterns
