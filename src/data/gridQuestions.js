/**
 * Grid (Jeopardy-style) Questions Database
 *
 * Each category should have exactly 5 questions with point values: 100, 200, 300, 400, 500
 * Each question has:
 * - question: The question text
 * - answer: The correct answer (case-insensitive matching)
 * - points: Point value (100, 200, 300, 400, 500)
 */

export const GRID_QUESTIONS = {
  'linux-basics': [
    {
      question: 'This command lists files in a directory',
      answer: 'ls',
      points: 100
    },
    {
      question: 'This command shows your current directory path',
      answer: 'pwd',
      points: 200
    },
    {
      question: 'This command changes file permissions using numbers',
      answer: 'chmod',
      points: 300
    },
    {
      question: 'This special file in your home directory configures bash settings',
      answer: '.bashrc',
      points: 400
    },
    {
      question: 'This command displays the first 10 lines of a file by default',
      answer: 'head',
      points: 500
    }
  ],

  'docker': [
    {
      question: 'This command shows running containers',
      answer: 'docker ps',
      points: 100
    },
    {
      question: 'This file defines instructions to build a Docker image',
      answer: 'Dockerfile',
      points: 200
    },
    {
      question: 'This flag runs a container in detached mode',
      answer: '-d',
      points: 300
    },
    {
      question: 'This command removes all stopped containers',
      answer: 'docker container prune',
      points: 400
    },
    {
      question: 'This Docker object allows containers to share data',
      answer: 'volume',
      points: 500
    }
  ],

  'git': [
    {
      question: 'This command shows the commit history',
      answer: 'git log',
      points: 100
    },
    {
      question: 'This command unstages a file',
      answer: 'git reset',
      points: 200
    },
    {
      question: 'This file tells Git which files to ignore',
      answer: '.gitignore',
      points: 300
    },
    {
      question: 'This command shows who last modified each line of a file',
      answer: 'git blame',
      points: 400
    },
    {
      question: 'This command creates a commit that undoes a previous commit',
      answer: 'git revert',
      points: 500
    }
  ],

  'networking': [
    {
      question: 'This is the default HTTP port',
      answer: '80',
      points: 100
    },
    {
      question: 'This protocol resolves domain names to IP addresses',
      answer: 'DNS',
      points: 200
    },
    {
      question: 'This command shows network interface configuration',
      answer: 'ifconfig',
      points: 300
    },
    {
      question: 'This is the private IP address range starting with 192.168',
      answer: '192.168.0.0/16',
      points: 400
    },
    {
      question: 'This protocol provides connection-oriented reliable delivery',
      answer: 'TCP',
      points: 500
    }
  ],

  'python': [
    {
      question: 'This built-in function returns the length of an object',
      answer: 'len',
      points: 100
    },
    {
      question: 'This keyword is used to define a lambda function',
      answer: 'lambda',
      points: 200
    },
    {
      question: 'This method adds an element to the end of a list',
      answer: 'append',
      points: 300
    },
    {
      question: 'This module provides mathematical functions like sqrt and sin',
      answer: 'math',
      points: 400
    },
    {
      question: 'This decorator marks a method as a class method',
      answer: '@classmethod',
      points: 500
    }
  ],

  'kubernetes': [
    {
      question: 'This command shows all pods in current namespace',
      answer: 'kubectl get pods',
      points: 100
    },
    {
      question: 'This type of service exposes pods on each node\'s IP',
      answer: 'NodePort',
      points: 200
    },
    {
      question: 'This resource limits CPU and memory for a namespace',
      answer: 'ResourceQuota',
      points: 300
    },
    {
      question: 'This tool manages Kubernetes package installations',
      answer: 'Helm',
      points: 400
    },
    {
      question: 'This component stores all cluster data as key-value pairs',
      answer: 'etcd',
      points: 500
    }
  ]
};

/**
 * Get questions for a specific grid category
 * @param {string} categoryId - The category ID (e.g., 'linux-basics')
 * @returns {Array} Array of 5 questions with point values
 */
export function getQuestionsForCategory(categoryId) {
  return GRID_QUESTIONS[categoryId] || [];
}
