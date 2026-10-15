/**
 * Quiz Questions Database
 *
 * Each quiz type should have exactly 10 questions.
 * Each question has:
 * - question: The question text
 * - answer: The correct answer (case-insensitive matching)
 * - hints: Array of 3 hints (revealed progressively during the game)
 */

export const QUIZ_QUESTIONS = {
  'linux-basics': [
    {
      question: 'What command lists files and directories?',
      answer: 'ls',
      hints: ['Shows directory contents', 'Two letters', 'Stands for "list"']
    },
    {
      question: 'What does cd stand for?',
      answer: 'change directory',
      hints: ['Used for navigation', 'Moves between folders', 'Two words']
    },
    {
      question: 'What command shows your current directory path?',
      answer: 'pwd',
      hints: ['Print working directory', 'Three letters', 'Shows full path']
    },
    {
      question: 'What command creates a new directory?',
      answer: 'mkdir',
      hints: ['Makes folders', 'Abbreviation for "make directory"', 'Five letters']
    },
    {
      question: 'What command removes a file?',
      answer: 'rm',
      hints: ['Deletes files', 'Be careful with this!', 'Two letters']
    },
    {
      question: 'What command copies files?',
      answer: 'cp',
      hints: ['Duplicates files', 'Two letters', 'Stands for "copy"']
    },
    {
      question: 'What command moves or renames files?',
      answer: 'mv',
      hints: ['Can relocate or rename', 'Two letters', 'Stands for "move"']
    },
    {
      question: 'What command displays file contents?',
      answer: 'cat',
      hints: ['Shows entire file', 'Three letters', 'Concatenate']
    },
    {
      question: 'What command shows running processes?',
      answer: 'ps',
      hints: ['Process status', 'Two letters', 'Shows what\'s running']
    },
    {
      question: 'What command changes file permissions?',
      answer: 'chmod',
      hints: ['Modifies access rights', 'Used with numbers like 755', 'Five letters']
    }
  ],

  'docker': [
    {
      question: 'What command builds a Docker image?',
      answer: 'docker build',
      hints: ['Creates image from Dockerfile', 'Two words', 'Uses Dockerfile']
    },
    {
      question: 'What command runs a Docker container?',
      answer: 'docker run',
      hints: ['Starts a container', 'Two words', 'Creates new container instance']
    },
    {
      question: 'What command lists running containers?',
      answer: 'docker ps',
      hints: ['Shows container status', 'Two words', 'PS stands for process status']
    },
    {
      question: 'What command stops a running container?',
      answer: 'docker stop',
      hints: ['Gracefully shuts down', 'Two words', 'Opposite of start']
    },
    {
      question: 'What command removes a container?',
      answer: 'docker rm',
      hints: ['Deletes stopped container', 'Two words', 'RM stands for remove']
    },
    {
      question: 'What command pulls an image from registry?',
      answer: 'docker pull',
      hints: ['Downloads image', 'Two words', 'From Docker Hub']
    },
    {
      question: 'What command shows Docker images?',
      answer: 'docker images',
      hints: ['Lists local images', 'Two words', 'Shows repository and tag']
    },
    {
      question: 'What file defines a Docker image?',
      answer: 'Dockerfile',
      hints: ['Build instructions', 'One word', 'Contains FROM, RUN, COPY']
    },
    {
      question: 'What command executes a command in running container?',
      answer: 'docker exec',
      hints: ['Runs command inside container', 'Two words', 'Often used with -it']
    },
    {
      question: 'What command shows container logs?',
      answer: 'docker logs',
      hints: ['Displays container output', 'Two words', 'Useful for debugging']
    }
  ],

  'git': [
    {
      question: 'What command initializes a new Git repository?',
      answer: 'git init',
      hints: ['Creates .git folder', 'Two words', 'Starts version control']
    },
    {
      question: 'What command stages changes for commit?',
      answer: 'git add',
      hints: ['Prepares files', 'Two words', 'Before commit']
    },
    {
      question: 'What command saves staged changes?',
      answer: 'git commit',
      hints: ['Creates snapshot', 'Two words', 'Use -m for message']
    },
    {
      question: 'What command shows repository status?',
      answer: 'git status',
      hints: ['Shows modified files', 'Two words', 'Shows what\'s staged']
    },
    {
      question: 'What command downloads remote repository?',
      answer: 'git clone',
      hints: ['Copies repository', 'Two words', 'Downloads from URL']
    },
    {
      question: 'What command uploads commits to remote?',
      answer: 'git push',
      hints: ['Sends changes', 'Two words', 'To remote server']
    },
    {
      question: 'What command downloads remote changes?',
      answer: 'git pull',
      hints: ['Gets updates', 'Two words', 'From remote server']
    },
    {
      question: 'What command creates a new branch?',
      answer: 'git branch',
      hints: ['Branch management', 'Two words', 'Creates or lists branches']
    },
    {
      question: 'What command switches branches?',
      answer: 'git checkout',
      hints: ['Changes branch', 'Two words', 'Can also restore files']
    },
    {
      question: 'What command combines branches?',
      answer: 'git merge',
      hints: ['Joins branches', 'Two words', 'Integrates changes']
    }
  ],

  'networking': [
    {
      question: 'What protocol does web browsing use?',
      answer: 'HTTP',
      hints: ['HyperText Transfer Protocol', 'Port 80', 'Four letters']
    },
    {
      question: 'What is the secure version of HTTP?',
      answer: 'HTTPS',
      hints: ['Uses SSL/TLS', 'Port 443', 'Five letters']
    },
    {
      question: 'What does DNS stand for?',
      answer: 'Domain Name System',
      hints: ['Translates names to IPs', 'Like a phone book', 'Three words']
    },
    {
      question: 'What is localhost IP address?',
      answer: '127.0.0.1',
      hints: ['Loopback address', 'Starts with 127', 'Four numbers']
    },
    {
      question: 'What protocol transfers files?',
      answer: 'FTP',
      hints: ['File Transfer Protocol', 'Port 21', 'Three letters']
    },
    {
      question: 'What protocol sends email?',
      answer: 'SMTP',
      hints: ['Simple Mail Transfer Protocol', 'Port 25', 'Four letters']
    },
    {
      question: 'What command tests network connectivity?',
      answer: 'ping',
      hints: ['ICMP packets', 'Four letters', 'Tests if host is reachable']
    },
    {
      question: 'What is the default SSH port?',
      answer: '22',
      hints: ['Secure Shell', 'Two digits', 'Less than 25']
    },
    {
      question: 'What does IP stand for?',
      answer: 'Internet Protocol',
      hints: ['Network layer protocol', 'Two words', 'Used with TCP']
    },
    {
      question: 'What is a subnet mask used for?',
      answer: 'network division',
      hints: ['Divides networks', 'Defines network portion', 'Two words']
    }
  ],

  'python': [
    {
      question: 'What keyword defines a function in Python?',
      answer: 'def',
      hints: ['Three letters', 'Short for define', 'Followed by function name']
    },
    {
      question: 'What function prints output in Python?',
      answer: 'print',
      hints: ['Displays text', 'Five letters', 'Basic output function']
    },
    {
      question: 'What keyword creates a loop over sequence?',
      answer: 'for',
      hints: ['Iteration', 'Three letters', 'Used with in']
    },
    {
      question: 'What keyword checks conditions?',
      answer: 'if',
      hints: ['Conditional statement', 'Two letters', 'Followed by else']
    },
    {
      question: 'What data type is [1, 2, 3]?',
      answer: 'list',
      hints: ['Mutable sequence', 'Four letters', 'Uses square brackets']
    },
    {
      question: 'What data type is {\'a\': 1}?',
      answer: 'dict',
      hints: ['Key-value pairs', 'Four letters', 'Short for dictionary']
    },
    {
      question: 'What keyword imports modules?',
      answer: 'import',
      hints: ['Brings in code', 'Six letters', 'Loads libraries']
    },
    {
      question: 'What keyword handles exceptions?',
      answer: 'try',
      hints: ['Error handling', 'Three letters', 'Used with except']
    },
    {
      question: 'What keyword creates a class?',
      answer: 'class',
      hints: ['Object-oriented', 'Five letters', 'Defines blueprint']
    },
    {
      question: 'What method initializes an object?',
      answer: '__init__',
      hints: ['Constructor', 'Double underscores', 'Called when creating instance']
    }
  ],

  'kubernetes': [
    {
      question: 'What is the smallest deployable unit in Kubernetes?',
      answer: 'pod',
      hints: ['Contains containers', 'Three letters', 'Can have multiple containers']
    },
    {
      question: 'What manages pod replicas?',
      answer: 'deployment',
      hints: ['Ensures desired state', 'One word', 'Manages scaling']
    },
    {
      question: 'What exposes pods as network service?',
      answer: 'service',
      hints: ['Network abstraction', 'One word', 'Load balances traffic']
    },
    {
      question: 'What command-line tool manages Kubernetes?',
      answer: 'kubectl',
      hints: ['Kubernetes control', 'Seven letters', 'Pronounced "cube control"']
    },
    {
      question: 'What stores configuration data?',
      answer: 'ConfigMap',
      hints: ['Non-sensitive data', 'One or two words', 'Key-value pairs']
    },
    {
      question: 'What stores sensitive data?',
      answer: 'Secret',
      hints: ['Encrypted storage', 'One word', 'Base64 encoded']
    },
    {
      question: 'What is a Kubernetes cluster manager called?',
      answer: 'control plane',
      hints: ['Manages cluster', 'Two words', 'Contains API server']
    },
    {
      question: 'What runs containers on nodes?',
      answer: 'kubelet',
      hints: ['Node agent', 'Seven letters', 'Ensures containers running']
    },
    {
      question: 'What provides persistent storage?',
      answer: 'PersistentVolume',
      hints: ['Storage resource', 'One or two words', 'Outlives pods']
    },
    {
      question: 'What routes traffic to services?',
      answer: 'Ingress',
      hints: ['HTTP/HTTPS routing', 'One word', 'External access']
    }
  ]
};

/**
 * Get questions for a specific quiz type
 * @param {string} quizTypeId - The quiz type ID (e.g., 'linux-basics')
 * @returns {Array} Array of 10 questions
 */
export function getQuestionsForQuizType(quizTypeId) {
  return QUIZ_QUESTIONS[quizTypeId] || [];
}
