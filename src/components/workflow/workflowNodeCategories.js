/**
 * Central registry of workflow node types, grouped by category.
 * Lives in its own module (not WorkflowNodeLibrary.jsx) so component files
 * only export components and Vite Fast Refresh keeps working for them.
 */
import { FileText, Globe, Code, Database, Eye, Clock, GitBranch, GitMerge, List, Play, Type, Hash, ToggleLeft, Braces, Download, IterationCw, ListPlus, Scale, Terminal, StickyNote, Lightbulb } from 'lucide-react';

/** Category holding the freeform (mind-map) nodes. */
export const NOTES_CATEGORY = 'Notes';

/**
 * Freeform annotation nodes: no execution pins, skipped by the execution
 * engine, and only ever joined by data-typed "link" edges.
 */
export const ANNOTATION_NODE_TYPES = ['note', 'idea'];

/** Node types that must never be the target of an execution edge. */
export const NO_EXEC_INPUT_NODE_TYPES = ['string', 'integer', 'text', 'boolean', 'object', 'array', ...ANNOTATION_NODE_TYPES];

export const NODE_CATEGORIES = [
  {
    category: 'Variables',
    nodes: [
      {
        type: 'string',
        label: 'String',
        description: 'Text value',
        icon: Type,
        color: 'blue'
      },
      {
        type: 'integer',
        label: 'Integer',
        description: 'Numeric value',
        icon: Hash,
        color: 'indigo'
      },
      {
        type: 'text',
        label: 'Text',
        description: 'Multi-line text',
        icon: FileText,
        color: 'cyan'
      },
      {
        type: 'boolean',
        label: 'Boolean',
        description: 'True/false value',
        icon: ToggleLeft,
        color: 'green'
      },
      {
        type: 'object',
        label: 'Object',
        description: 'JSON data',
        icon: Braces,
        color: 'purple'
      },
      {
        type: 'array',
        label: 'Array',
        description: 'JSON array',
        icon: List,
        color: 'sky'
      }
    ]
  },
  {
    category: 'Control Flow',
    nodes: [
      {
        type: 'beginplay',
        label: 'Begin Play',
        description: 'Entry point',
        icon: Play,
        color: 'emerald'
      },
      {
        type: 'branch',
        label: 'Branch',
        description: 'True/false condition',
        icon: GitBranch,
        color: 'orange'
      },
      {
        type: 'switch',
        label: 'Switch',
        description: 'Value-based routing',
        icon: GitMerge,
        color: 'yellow'
      },
      {
        type: 'sequence',
        label: 'Sequence',
        description: 'Execute in order',
        icon: List,
        color: 'teal'
      },
      {
        type: 'delay',
        label: 'Delay',
        description: 'Wait for duration',
        icon: Clock,
        color: 'amber'
      },
      {
        type: 'forloop',
        label: 'For Loop',
        description: 'Iterate over array',
        icon: IterationCw,
        color: 'violet'
      }
    ]
  },
  {
    category: 'Actions',
    nodes: [
      {
        type: 'restapi',
        label: 'REST API',
        description: 'HTTP request',
        icon: Globe,
        color: 'green'
      },
      {
        type: 'ssh',
        label: 'SSH Command',
        description: 'Execute remote SSH command',
        icon: Terminal,
        color: 'red'
      },
      {
        type: 'transformation',
        label: 'Transform',
        description: 'JavaScript processor',
        icon: Code,
        color: 'purple'
      },
      {
        type: 'storage',
        label: 'Set Variable',
        description: 'Store value in a variable',
        icon: Database,
        color: 'orange'
      },
      {
        type: 'variablereference',
        label: 'Get Variable',
        description: 'Reference stored data',
        icon: FileText,
        color: 'amber'
      },
      {
        type: 'visualizer',
        label: 'Visualizer',
        description: 'Inspect data',
        icon: Eye,
        color: 'pink'
      },
      {
        type: 'makearray',
        label: 'Make Array',
        description: 'String to array',
        icon: ListPlus,
        color: 'slate'
      },
      {
        type: 'comparison',
        label: 'Comparison',
        description: 'Compare two values',
        icon: Scale,
        color: 'cyan'
      },
      {
        type: 'result',
        label: 'Result',
        description: 'Workflow result',
        icon: Download,
        color: 'blue'
      }
    ]
  },
  {
    category: NOTES_CATEGORY,
    nodes: [
      {
        type: 'note',
        label: 'Note',
        description: 'Freeform sticky note',
        icon: StickyNote,
        color: 'yellow'
      },
      {
        type: 'idea',
        label: 'Idea',
        description: 'Mind-map topic bubble',
        icon: Lightbulb,
        color: 'amber'
      }
    ]
  }
];
