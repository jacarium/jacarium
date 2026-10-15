"""AI chat routes (/api/ai/*) and per-provider chat handlers."""
import os

from flask import Blueprint, request, jsonify

from extensions import debug_print
from settings_store import setting
from user_context import accounts_mode
from ssh_interactive import get_ssh_connection, drop_ssh_connection

ai_chat_bp = Blueprint('ai_chat', __name__)

# Timeout (seconds) for requests to the user-configured custom/Ollama endpoint.
# Applies as both the connect timeout and the max gap between received bytes,
# so it will not cut off a slow-but-live stream - only a fully silent connection.
CUSTOM_AI_TIMEOUT = 120

# SSH Chat Sessions - track which gemini sessions have been created
# Maps session_id -> True for sessions that exist on the remote gemini CLI
gemini_sessions_created = set()


@ai_chat_bp.route("/api/ai/health", methods=["GET"])
def ai_health():
    """Health check endpoint for AI service"""
    return jsonify({
        "status": "online",
        "service": "ai-assistant",
        "version": "1.0"
    })


@ai_chat_bp.route("/api/ai/models", methods=["GET"])
def ai_models():
    """Get available models for configured AI providers"""
    try:
        # Reload environment variables from settings file
        # This allows changes to be picked up without restarting the backend
        # The same file the rest of the backend uses: JACARIUM_ENV_FILE
        # when set (the container's /data volume), else ~/.jacarium.env.
        # (with accounts nothing is loaded into the process environment:
        # setting() resolves the account's file and the server defaults)
        if not accounts_mode():
            from dotenv import load_dotenv
            from settings_store import env_file_path
            load_dotenv(env_file_path(), override=True)

        models = {
            "anthropic": [],
            "openai": [],
            "gemini": [],
            "ollama": []
        }

        # Anthropic models - dynamically detect based on provider
        if setting('ANTHROPIC_API_KEY'):
            # Direct API key - fetch from Anthropic Models API
            try:
                import requests
                api_key = setting('ANTHROPIC_API_KEY')
                anthropic_models = []

                # Handle pagination to get all models
                url = 'https://api.anthropic.com/v1/models'
                has_more = True
                after_id = None

                while has_more:
                    params = {}
                    if after_id:
                        params['after_id'] = after_id

                    response = requests.get(
                        url,
                        headers={
                            'anthropic-version': '2023-06-01',
                            'x-api-key': api_key
                        },
                        params=params,
                        timeout=5
                    )

                    if response.status_code == 200:
                        data = response.json()

                        # Extract model info (id and display_name)
                        for model_info in data.get('data', []):
                            model_id = model_info.get('id')
                            display_name = model_info.get('display_name', model_id)
                            if model_id:
                                # Store as dict with id and label
                                anthropic_models.append({
                                    'id': model_id,
                                    'label': display_name
                                })

                        # Check if there are more pages
                        has_more = data.get('has_more', False)
                        if has_more:
                            after_id = data.get('last_id')
                        else:
                            break
                    else:
                        print(f"[AI Models] Anthropic API returned status {response.status_code}")
                        break

                if anthropic_models:
                    models['anthropic'] = anthropic_models
                    debug_print(f"[AI Models] Found {len(anthropic_models)} Anthropic models")
            except Exception as e:
                print(f"[AI Models] Error fetching Anthropic models: {e}")
                # Don't set any models if API fails

        elif setting('ANTHROPIC_USE_VERTEX') == 'true':
            # Vertex AI - use user-configured models
            try:
                project_id = setting('ANTHROPIC_GCP_PROJECT_ID')
                location = setting('ANTHROPIC_GCP_LOCATION')
                models_config = setting('ANTHROPIC_VERTEX_MODELS', '')

                if project_id and location and models_config:
                    # Parse comma-separated model list
                    # Format: "model-id:Display Name,model-id-2:Display Name 2"
                    # Or just: "model-id,model-id-2" (uses model ID as label)
                    vertex_models = []
                    for model_entry in models_config.split(','):
                        model_entry = model_entry.strip()
                        if ':' in model_entry:
                            # Format with custom label: "model-id:Display Name"
                            model_id, label = model_entry.split(':', 1)
                            vertex_models.append({
                                'id': model_id.strip(),
                                'label': label.strip()
                            })
                        elif model_entry:
                            # Just model ID, use it as both ID and label
                            vertex_models.append({
                                'id': model_entry,
                                'label': model_entry
                            })

                    if vertex_models:
                        models['anthropic'] = vertex_models
                        debug_print(f"[AI Models] Configured {len(vertex_models)} Claude models for Vertex AI ({location})")
            except Exception as e:
                print(f"[AI Models] Error configuring Vertex AI: {e}")
                # Don't set any models if Vertex is not properly configured

        elif setting('ANTHROPIC_USE_BEDROCK') == 'true':
            # AWS Bedrock - list from Bedrock
            try:
                # Check if boto3 is available
                try:
                    import boto3
                except ImportError:
                    print(f"[AI Models] boto3 module not installed. Install with: pip install boto3")
                    pass
                else:
                    bedrock = boto3.client('bedrock', region_name=setting('AWS_REGION', 'us-east-1'))

                    response = bedrock.list_foundation_models(
                        byProvider='Anthropic'
                    )

                    bedrock_models = []
                    for model in response.get('modelSummaries', []):
                        model_id = model.get('modelId', '')
                        if model_id:
                            bedrock_models.append(model_id)

                    if bedrock_models:
                        models['anthropic'] = bedrock_models
                    # If no models found, leave empty
            except Exception as e:
                print(f"[AI Models] Error listing Bedrock models: {e}")
                # Don't set any models if Bedrock is not properly configured

        # OpenAI models - list from OpenAI API
        if setting('OPENAI_API_KEY'):
            try:
                # Check if openai module is available
                try:
                    import openai
                except ImportError:
                    print(f"[AI Models] openai module not installed. Install with: pip install openai")
                    pass
                else:
                    openai.api_key = setting('OPENAI_API_KEY')

                    # List available models
                    response = openai.models.list()
                    openai_models = []

                    # Filter for GPT models
                    for model in response.data:
                        if model.id.startswith('gpt-'):
                            openai_models.append(model.id)

                    # Sort and use common ones
                    common_models = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo']
                    available_common = [m for m in common_models if m in openai_models]
                    models['openai'] = available_common if available_common else openai_models[:5]
            except Exception as e:
                print(f"[AI Models] Error listing OpenAI models: {e}")
                # Don't set any models if OpenAI is not properly configured

        # Gemini models - list from API or Vertex
        if setting('GEMINI_API_KEY'):
            try:
                from google import genai
                client = genai.Client(api_key=setting('GEMINI_API_KEY'))

                # List available models (supported_actions carries the API's
                # supportedGenerationMethods)
                gemini_models = []
                for model in client.models.list():
                    if 'generateContent' in (model.supported_actions or []):
                        # Extract model name (e.g., "models/gemini-pro" -> "gemini-pro")
                        model_name = model.name.split('/')[-1]
                        gemini_models.append(model_name)

                if gemini_models:
                    models['gemini'] = gemini_models
                # If no models found, leave empty
            except Exception as e:
                print(f"[AI Models] Error listing Gemini models: {e}")
                # Don't set any models if Gemini is not properly configured
        elif setting('GEMINI_USE_VERTEX') == 'true':
            # Vertex AI - use user-configured models
            try:
                project_id = setting('GEMINI_PROJECT_ID')
                location = setting('GEMINI_LOCATION')
                models_config = setting('GEMINI_VERTEX_MODELS', '')

                if project_id and location and models_config:
                    # Parse comma-separated model list
                    # Format: "model-id:Display Name,model-id-2:Display Name 2"
                    # Or just: "model-id,model-id-2" (uses model ID as label)
                    gemini_models = []
                    for model_entry in models_config.split(','):
                        model_entry = model_entry.strip()
                        if ':' in model_entry:
                            # Format with custom label: "model-id:Display Name"
                            model_id, label = model_entry.split(':', 1)
                            gemini_models.append({
                                'id': model_id.strip(),
                                'label': label.strip()
                            })
                        elif model_entry:
                            # Just model ID, use it as both ID and label
                            gemini_models.append({
                                'id': model_entry,
                                'label': model_entry
                            })

                    if gemini_models:
                        models['gemini'] = gemini_models
                        debug_print(f"[AI Models] Configured {len(gemini_models)} Gemini models for Vertex AI ({location})")
            except Exception as e:
                print(f"[AI Models] Error configuring Vertex Gemini: {e}")
                # Don't set any models if Vertex Gemini is not properly configured

        # Try to fetch Ollama models if endpoint is configured
        custom_endpoint = setting('CUSTOM_AI_ENDPOINT')
        if custom_endpoint:
            is_ollama = 'ollama' in custom_endpoint.lower() or ':11434' in custom_endpoint
            if is_ollama:
                try:
                    import requests
                    # Extract base URL (remove /api/chat if present)
                    base_url = custom_endpoint.replace('/api/chat', '').replace('/api/generate', '')
                    tags_url = f"{base_url}/api/tags"

                    response = requests.get(tags_url, timeout=2)
                    if response.status_code == 200:
                        data = response.json()
                        ollama_models = [model['name'] for model in data.get('models', [])]
                        models['ollama'] = ollama_models
                except Exception as e:
                    print(f"[AI Models] Could not fetch Ollama models: {e}")
                    models['ollama'] = []

        # SSH AI models - single config from environment variables
        if setting('SSH_AI_HOST'):
            display_name = setting('SSH_AI_DISPLAY_NAME', 'SSH AI')
            models['ssh'] = [{
                'id': 'ssh-ai',
                'label': display_name,
                'config': {
                    'name': 'ssh-ai',
                    'label': display_name,
                    'host': setting('SSH_AI_HOST'),
                    'user': setting('SSH_AI_USER', 'user'),
                    # The password never leaves the backend (write-only secret):
                    # handle_ssh_chat reads it from the settings when the
                    # request carries none.
                    'password': '',
                    'commandInitial': setting('SSH_AI_COMMAND_INITIAL', ''),
                    'commandFollowup': setting('SSH_AI_COMMAND_FOLLOWUP', ''),
                    'commandTimeout': setting('SSH_AI_COMMAND_TIMEOUT', '')
                }
            }]
            debug_print(f"[AI Models] Configured SSH AI: {display_name}")

        return jsonify(models)

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[AI Models Error] {error_trace}")
        return jsonify({"error": str(e)}), 500


@ai_chat_bp.route("/api/ai/ask", methods=["POST"])
def ai_ask():
    """Handle simple AI ask requests with a single message"""
    try:
        data = request.json
        message = data.get('message', '')
        system_prompt = data.get('systemPrompt', '')
        provider = data.get('provider', 'anthropic')  # Default to anthropic
        model = data.get('model')
        temperature = data.get('temperature', 0)
        max_tokens = data.get('maxTokens', 1000)

        debug_print(f"[AI Ask] Provider: {provider}, Message: {message[:50]}...")

        if not message:
            return jsonify({"error": "No message provided"}), 400

        # Build messages array
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": message})

        # Get API response based on provider
        if provider == 'openai':
            if not model:
                model = 'gpt-4'
            response_message = handle_openai_chat(messages, model, temperature, max_tokens)
        elif provider == 'anthropic':
            if not model:
                model = 'claude-sonnet-4-5@20250929'
            response_message = handle_anthropic_chat(messages, model, temperature, max_tokens)
        elif provider == 'gemini':
            if not model:
                model = 'gemini-pro'
            response_message = handle_gemini_chat(messages, model, temperature, max_tokens)
        elif provider == 'ollama' or provider == 'custom':
            response_message = handle_custom_chat(messages, model, temperature, max_tokens)
        else:
            return jsonify({"error": f"Unknown provider: {provider}"}), 400

        return jsonify({"response": response_message})

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[AI Ask Error] {error_trace}")
        return jsonify({"error": f"{str(e)}\n\nCheck backend console for full traceback."}), 500


@ai_chat_bp.route("/api/ai/chat", methods=["POST"])
def ai_chat():
    """Handle AI chat requests supporting multiple providers"""
    try:
        data = request.json
        messages = data.get('messages', [])
        provider = data.get('provider', 'openai')
        model = data.get('model', 'gpt-4')
        temperature = data.get('temperature', 0)
        max_tokens = data.get('maxTokens', 2000)

        # Display provider and model
        model_display = model
        if provider == 'ssh':
            model_display = 'Gemini (SSH)'
        debug_print(f"[AI Chat] Provider: {provider}, Model: {model_display}, Messages: {len(messages)}")

        if not messages:
            return jsonify({"error": "No messages provided"}), 400

        # Get API response based on provider
        if provider == 'openai':
            response_message = handle_openai_chat(messages, model, temperature, max_tokens)
        elif provider == 'anthropic':
            response_message = handle_anthropic_chat(messages, model, temperature, max_tokens)
        elif provider == 'gemini':
            response_message = handle_gemini_chat(messages, model, temperature, max_tokens)
        elif provider == 'ollama' or provider == 'custom':
            response_message = handle_custom_chat(messages, model, temperature, max_tokens)
        elif provider == 'ssh':
            ssh_config = data.get('sshConfig', {})
            response_message = handle_ssh_chat(messages, model, ssh_config)
        else:
            return jsonify({"error": f"Unknown provider: {provider}"}), 400

        return jsonify({"message": response_message})

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[AI Chat Error] {error_trace}")
        return jsonify({"error": f"{str(e)}\n\nCheck backend console for full traceback."}), 500


@ai_chat_bp.route("/api/ai/chat-stream", methods=["POST"])
def ai_chat_stream():
    """Handle AI chat requests with streaming support (SSE)"""
    from flask import Response, stream_with_context
    import json

    def generate():
        try:
            data = request.json
            messages = data.get('messages', [])
            provider = data.get('provider', 'openai')
            model = data.get('model', 'gpt-4')
            temperature = data.get('temperature', 0)
            max_tokens = data.get('maxTokens', 2000)

            debug_print(f"[AI Chat Stream] Provider: {provider}, Model: {model}")

            if not messages:
                yield f"data: {json.dumps({'error': 'No messages provided'})}\n\n"
                return

            # Stream response based on provider
            if provider == 'ollama' or provider == 'custom':
                for chunk in handle_custom_chat_stream(messages, model, temperature, max_tokens):
                    yield f"data: {json.dumps(chunk)}\n\n"
            elif provider == 'anthropic':
                for chunk in handle_anthropic_chat_stream(messages, model, temperature, max_tokens):
                    yield f"data: {json.dumps(chunk)}\n\n"
            else:
                # Fallback to non-streaming for unsupported providers
                if provider == 'openai':
                    response_message = handle_openai_chat(messages, model, temperature, max_tokens)
                elif provider == 'gemini':
                    response_message = handle_gemini_chat(messages, model, temperature, max_tokens)
                elif provider == 'ssh':
                    ssh_config = data.get('sshConfig', {})
                    response_message = handle_ssh_chat(messages, model, ssh_config)
                else:
                    yield f"data: {json.dumps({'error': f'Unknown provider: {provider}'})}\n\n"
                    return

                # Send as single chunk
                yield f"data: {json.dumps({'type': 'content', 'content': response_message})}\n\n"

            # Send done signal
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f"[AI Chat Stream Error] {error_trace}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


def handle_openai_chat(messages, model, temperature, max_tokens):
    """Handle OpenAI API chat"""
    import openai

    api_key = setting('OPENAI_API_KEY')
    if not api_key:
        raise ValueError("OPENAI_API_KEY not found in environment variables")

    openai.api_key = api_key

    # Convert message format
    formatted_messages = [
        {"role": msg["role"], "content": msg["content"]}
        for msg in messages
    ]

    response = openai.ChatCompletion.create(
        model=model,
        messages=formatted_messages,
        temperature=temperature,
        max_tokens=max_tokens
    )

    return response.choices[0].message.content


def handle_anthropic_chat(messages, model, temperature, max_tokens):
    """Handle Anthropic API chat - supports API key, AWS Bedrock, and GCP Vertex AI"""
    use_bedrock = setting('ANTHROPIC_USE_BEDROCK', 'false').lower() == 'true'
    use_vertex = setting('ANTHROPIC_USE_VERTEX', 'false').lower() == 'true'

    # Convert messages format - Anthropic requires system message separate
    system_message = ""
    formatted_messages = []

    for msg in messages:
        if msg["role"] == "system":
            system_message = msg["content"]
        else:
            formatted_messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })

    if use_bedrock:
        # Use AWS Bedrock with AWS credentials
        import boto3
        import json

        aws_region = setting('AWS_REGION', 'us-east-1')

        bedrock_runtime = boto3.client(
            service_name='bedrock-runtime',
            region_name=aws_region
        )

        # Bedrock model ID format
        bedrock_model_id = model if model else "anthropic.claude-3-5-sonnet-20241022-v2:0"

        # Build the request body for Bedrock
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": formatted_messages
        }

        # Add system message as a list if present
        if system_message:
            request_body["system"] = [{"type": "text", "text": system_message}]

        response = bedrock_runtime.invoke_model(
            modelId=bedrock_model_id,
            body=json.dumps(request_body)
        )

        response_body = json.loads(response['body'].read())
        return response_body['content'][0]['text']

    elif use_vertex:
        # Use Google Cloud Vertex AI with gcloud credentials
        from anthropic import AnthropicVertex

        project_id = setting('ANTHROPIC_GCP_PROJECT_ID')
        location = setting('ANTHROPIC_GCP_LOCATION', 'us-east5')

        if not project_id:
            raise ValueError("ANTHROPIC_GCP_PROJECT_ID not found in environment variables when using Vertex AI")

        client = AnthropicVertex(
            project_id=project_id,
            region=location
        )

        # Build request parameters
        request_params = {
            "model": model if model else "claude-sonnet-4-5@20250929",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": formatted_messages
        }

        # Add system message as a list if present
        if system_message:
            request_params["system"] = [{"type": "text", "text": system_message}]

        response = client.messages.create(**request_params)

        return response.content[0].text

    else:
        # Use direct API key authentication
        import anthropic

        api_key = setting('ANTHROPIC_API_KEY')
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not found in environment variables")

        client = anthropic.Anthropic(api_key=api_key)

        # Build request parameters
        request_params = {
            "model": model if model else "claude-sonnet-4-5@20250929",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": formatted_messages
        }

        # Add system message - direct API accepts string or list
        if system_message:
            request_params["system"] = system_message

        response = client.messages.create(**request_params)

        return response.content[0].text


def _gemini_system_instruction(messages):
    """The system messages (e.g. /api/ai/ask's system prompt) joined in
    order, for GenerateContentConfig.system_instruction; None when there are
    none."""
    parts = [msg["content"] for msg in messages if msg.get("role") == "system" and msg.get("content")]
    return "\n\n".join(parts) if parts else None


def handle_gemini_chat(messages, model, temperature, max_tokens):
    """Handle Google Gemini API chat - supports both API key and Vertex AI"""
    use_vertex = setting('GEMINI_USE_VERTEX', 'false').lower() == 'true'
    system_instruction = _gemini_system_instruction(messages)

    if use_vertex:
        # Use Vertex AI with gcloud authentication
        from google import genai
        from google.genai import types

        project_id = setting('GEMINI_PROJECT_ID')
        location = setting('GEMINI_LOCATION', 'us-central1')

        if not project_id:
            raise ValueError("GEMINI_PROJECT_ID not found in environment variables when using Vertex AI")

        client = genai.Client(
            vertexai=True,
            project=project_id,
            location=location
        )

        # Build conversation context (system messages go to
        # system_instruction instead)
        conversation_text = ""
        for msg in messages:
            if msg["role"] == "system":
                continue
            role = "User" if msg["role"] == "user" else "Assistant"
            conversation_text += f"{role}: {msg['content']}\n\n"

        response = client.models.generate_content(
            model=model if model else "gemini-2.0-flash-exp",
            contents=conversation_text,
            config=types.GenerateContentConfig(system_instruction=system_instruction) if system_instruction else None
        )

        return response.text
    else:
        # Use API key authentication
        from google import genai
        from google.genai import types

        api_key = setting('GEMINI_API_KEY')
        if not api_key:
            raise ValueError("GEMINI_API_KEY not found in environment variables")

        client = genai.Client(api_key=api_key)

        # Create the chat (the SDK keeps the history on the Chat object). The
        # system instruction is set on the chat (it applies to the replayed
        # messages) and repeated on the last message, whose own config would
        # otherwise replace the chat's.
        chat = client.chats.create(
            model=model if model else 'gemini-pro',
            history=[],
            config=types.GenerateContentConfig(system_instruction=system_instruction) if system_instruction else None
        )

        # Send all previous messages
        for msg in messages[:-1]:
            if msg["role"] == "user":
                chat.send_message(msg["content"])

        # Send the last message and get response
        last_message = messages[-1]["content"]
        last_config = {"temperature": temperature, "max_output_tokens": max_tokens}
        if system_instruction:
            last_config["system_instruction"] = system_instruction
        response = chat.send_message(
            last_message,
            config=types.GenerateContentConfig(**last_config)
        )

        return response.text


def handle_custom_chat(messages, model, temperature, max_tokens):
    """Handle custom API endpoint - supports both OpenAI-compatible and Ollama formats"""
    import requests

    custom_endpoint = setting('CUSTOM_AI_ENDPOINT')
    custom_api_key = setting('CUSTOM_API_KEY')

    if not custom_endpoint:
        raise ValueError("CUSTOM_AI_ENDPOINT not found in environment variables")

    headers = {
        'Content-Type': 'application/json',
    }

    # Detect if this is an Ollama endpoint
    is_ollama = 'ollama' in custom_endpoint.lower() or ':11434' in custom_endpoint

    if is_ollama:
        # Ollama format
        payload = {
            'model': model,
            'messages': messages,
            'stream': False,
            'options': {
                'temperature': temperature,
                'num_predict': max_tokens,
                # Enlarged context window so RAG context + history isn't
                # silently truncated (Ollama's default is ~2048-4096 tokens)
                'num_ctx': 8192
            }
        }

        # Only add 'think' parameter for models that support it
        # GPT-OSS and some other reasoning models support thinking
        if 'gpt-oss' in model.lower() or 'deepseek-r1' in model.lower() or 'qwen3' in model.lower():
            payload['think'] = 'medium'  # GPT-OSS uses low/medium/high
    else:
        # OpenAI-compatible format
        if custom_api_key:
            headers['Authorization'] = f'Bearer {custom_api_key}'

        payload = {
            'messages': messages,
            'model': model,
            'temperature': temperature,
            'max_tokens': max_tokens
        }

    response = requests.post(custom_endpoint, json=payload, headers=headers, timeout=CUSTOM_AI_TIMEOUT)
    response.raise_for_status()

    data = response.json()

    # Parse response based on format
    if is_ollama:
        # Ollama response format: {"message": {"role": "assistant", "content": "..."}}
        return data.get('message', {}).get('content', 'No response')
    else:
        # OpenAI-compatible format
        return data.get('message', data.get('choices', [{}])[0].get('message', {}).get('content', 'No response'))


def handle_custom_chat_stream(messages, model, temperature, max_tokens):
    """Handle custom API endpoint with streaming - supports both OpenAI-compatible and Ollama formats"""
    import requests
    import json

    custom_endpoint = setting('CUSTOM_AI_ENDPOINT')
    custom_api_key = setting('CUSTOM_API_KEY')

    if not custom_endpoint:
        raise ValueError("CUSTOM_AI_ENDPOINT not found in environment variables")

    headers = {
        'Content-Type': 'application/json',
    }

    # Detect if this is an Ollama endpoint
    is_ollama = 'ollama' in custom_endpoint.lower() or ':11434' in custom_endpoint

    if is_ollama:
        # Ollama format with streaming
        payload = {
            'model': model,
            'messages': messages,
            'stream': True,
            'options': {
                'temperature': temperature,
                'num_predict': max_tokens,
                # Enlarged context window so RAG context + history isn't
                # silently truncated (Ollama's default is ~2048-4096 tokens)
                'num_ctx': 8192
            }
        }

        # Only add 'think' parameter for models that support it
        # GPT-OSS and some other reasoning models support thinking
        if 'gpt-oss' in model.lower() or 'deepseek-r1' in model.lower() or 'qwen3' in model.lower():
            payload['think'] = 'medium'  # GPT-OSS uses low/medium/high
    else:
        # OpenAI-compatible format with streaming
        if custom_api_key:
            headers['Authorization'] = f'Bearer {custom_api_key}'

        payload = {
            'messages': messages,
            'model': model,
            'temperature': temperature,
            'max_tokens': max_tokens,
            'stream': True
        }

    response = requests.post(custom_endpoint, json=payload, headers=headers, stream=True, timeout=CUSTOM_AI_TIMEOUT)
    response.raise_for_status()

    thinking_active = False
    accumulated_text = ''
    buffer = ''  # Buffer to accumulate partial chunks

    # Stream response chunks
    for line in response.iter_lines():
        if not line:
            continue

        try:
            # Ollama returns newline-delimited JSON
            chunk_data = json.loads(line)

            if is_ollama:
                # Ollama streaming format with thinking support
                # {"message": {"thinking": "...", "content": "..."}, "done": false}
                message = chunk_data.get('message', {})
                thinking = message.get('thinking', '')
                content = message.get('content', '')
                done = chunk_data.get('done', False)

                # Handle thinking content
                if thinking:
                    if not thinking_active:
                        thinking_active = True
                        yield {'type': 'thinking_start'}

                    yield {'type': 'thinking', 'content': thinking}

                # Handle regular content (can appear with or without thinking)
                if content:
                    if thinking_active:
                        # First content chunk after thinking means thinking is done
                        thinking_active = False
                        yield {'type': 'thinking_end'}

                    yield {'type': 'content', 'content': content}

                if done:
                    # If we're done but still in thinking mode, send thinking_end
                    if thinking_active:
                        yield {'type': 'thinking_end'}
                    break
            else:
                # OpenAI-compatible format
                if 'choices' in chunk_data and len(chunk_data['choices']) > 0:
                    delta = chunk_data['choices'][0].get('delta', {})
                    content = delta.get('content', '')

                    if content:
                        yield {'type': 'content', 'content': content}

                    if chunk_data['choices'][0].get('finish_reason'):
                        break

        except json.JSONDecodeError:
            continue


def handle_anthropic_chat_stream(messages, model, temperature, max_tokens):
    """Handle Anthropic API chat with streaming support - supports API key, AWS Bedrock, and GCP Vertex AI"""
    use_bedrock = setting('ANTHROPIC_USE_BEDROCK', 'false').lower() == 'true'
    use_vertex = setting('ANTHROPIC_USE_VERTEX', 'false').lower() == 'true'

    if use_bedrock:
        # Bedrock doesn't support streaming in the same way, fall back to non-streaming
        raise ValueError("Bedrock streaming not yet implemented - use non-streaming endpoint")

    if use_vertex:
        # Use Google Cloud Vertex AI with gcloud credentials
        from anthropic import AnthropicVertex

        project_id = setting('ANTHROPIC_GCP_PROJECT_ID')
        location = setting('ANTHROPIC_GCP_LOCATION', 'us-east5')

        if not project_id:
            raise ValueError("ANTHROPIC_GCP_PROJECT_ID not found in environment variables when using Vertex AI")

        client = AnthropicVertex(
            project_id=project_id,
            region=location
        )
    else:
        # Use direct API key authentication
        import anthropic

        api_key = setting('ANTHROPIC_API_KEY')
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not found in environment variables")

        client = anthropic.Anthropic(api_key=api_key)

    # Convert messages format
    system_message = ""
    formatted_messages = []

    for msg in messages:
        if msg['role'] == 'system':
            system_message = msg['content']
        else:
            formatted_messages.append({
                "role": msg['role'],
                "content": msg['content']
            })

    # Build request parameters
    request_params = {
        "model": model if model else "claude-sonnet-4-5@20250929",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": formatted_messages
    }

    if system_message:
        request_params["system"] = [{"type": "text", "text": system_message}]

    # Stream response - the .stream() method automatically enables streaming
    thinking_active = False

    with client.messages.stream(**request_params) as stream:
        for event in stream:
            if hasattr(event, 'type'):
                if event.type == 'content_block_start':
                    # Check if this is a thinking block
                    if hasattr(event, 'content_block') and hasattr(event.content_block, 'type'):
                        if event.content_block.type == 'thinking':
                            thinking_active = True
                            yield {'type': 'thinking_start'}
                elif event.type == 'content_block_delta':
                    if hasattr(event, 'delta'):
                        # Check delta type - text vs thinking
                        if hasattr(event.delta, 'thinking'):
                            yield {'type': 'thinking', 'content': event.delta.thinking}
                        elif hasattr(event.delta, 'text'):
                            # If we were in thinking mode, end it
                            if thinking_active:
                                thinking_active = False
                                yield {'type': 'thinking_end'}
                            yield {'type': 'content', 'content': event.delta.text}
                elif event.type == 'content_block_stop':
                    # If thinking block ended without content starting
                    if thinking_active:
                        thinking_active = False
                        yield {'type': 'thinking_end'}


def render_ssh_ai_command(template, user_message):
    """Expand {{MESSAGE}} in a remote-command template WITHOUT ever splicing
    the raw user message into the shell string.

    The message is base64-encoded here and decoded remotely via
    $(printf %s <base64> | base64 -d), so no character of the message ever
    reaches the remote shell's parser. This matters because:

      - exec_command() only takes a single shell command string (paramiko has
        no argv-style exec), so SOME quoting context is unavoidable;
      - the template is user-customizable (commandInitial/commandFollowup),
        so we cannot know whether {{MESSAGE}} sits inside double quotes,
        single quotes, or no quotes at all. Any escaping scheme matched to
        one quoting style is wrong for the others - the previous code
        escaped for single quotes while the default templates use double
        quotes, which let $(...), backticks and $VARs inside a chat message
        EXECUTE on the SSH host (users paste arbitrary log excerpts here).

    Base64 output is [A-Za-z0-9+/=] only - inert in every POSIX quoting
    context - so this is safe regardless of the template's quote style.

    Placeholder handling keeps the contract users expect from writing
    "{{MESSAGE}}" or '{{MESSAGE}}' in a custom template: a quoted placeholder
    (quotes immediately around it) is replaced INCLUDING its quotes so the
    message still arrives as one literal argument; a bare placeholder gets
    its own double quotes for the same reason. The one visible difference
    from literal splicing: command substitution strips trailing newlines
    from the message (harmless for chat prompts).
    """
    import base64

    encoded = base64.b64encode(user_message.encode('utf-8')).decode('ascii')
    quoted_decode_expr = '"$(printf %s ' + encoded + ' | base64 -d)"'

    command = template
    # Quoted placeholder: swap the surrounding quotes for our own so the
    # decode expression always sits in a double-quoted context ($(...) is
    # never expanded inside single quotes, so leaving a template's single
    # quotes in place would pass the expression through literally).
    for quoted_placeholder in ('"{{MESSAGE}}"', "'{{MESSAGE}}'"):
        command = command.replace(quoted_placeholder, quoted_decode_expr)
    # Bare placeholder: add our own double quotes (prevents word splitting).
    command = command.replace('{{MESSAGE}}', quoted_decode_expr)
    return command


def handle_ssh_chat(messages, model, ssh_config):
    """Handle SSH-based chat using gemini -p with -o json for structured output"""
    import subprocess
    import json
    import re

    # Get SSH connection details
    ssh_host = ssh_config.get('host')
    ssh_user = ssh_config.get('user')
    ssh_password = ssh_config.get('password') or setting('SSH_AI_PASSWORD') or None  # Optional password
    # `.get(key, default)` only falls back when the key is MISSING, not when
    # it's present but blank -- and the settings UI's command-template fields
    # only show the default as a placeholder (never submitted if the user
    # leaves the field untouched), so a saved-but-blank commandInitial/
    # commandFollowup is a real, observed case, not hypothetical. `or` covers
    # both missing and blank.
    ssh_command_initial = ssh_config.get('commandInitial') or 'gemini -p "{{MESSAGE}}" -o json --session-id {{SESSION_ID}} | jq -r .response'
    ssh_command_followup = ssh_config.get('commandFollowup') or 'gemini -p "{{MESSAGE}}" -o json --resume {{SESSION_ID}} | jq -r .response'
    conversation_id = ssh_config.get('conversationId', 'default')

    # Timeout (seconds) for the remote command to produce its output.
    # Paramiko's exec_command(timeout=N) sets the channel read timeout, so
    # this bounds how long we wait for the remote AI CLI to respond -- not
    # just how long the command takes to start. Remote LLM CLIs can
    # legitimately take longer than the default, so it is configurable via
    # sshConfig.commandTimeout (SSH_AI_COMMAND_TIMEOUT).
    try:
        command_timeout = float(ssh_config.get('commandTimeout') or 120)
        if command_timeout <= 0:
            command_timeout = 120.0
    except (TypeError, ValueError):
        command_timeout = 120.0

    if not ssh_host or not ssh_user:
        raise ValueError("SSH host and user are required for SSH provider")

    # Get the last user message as the prompt
    # Note: We only send the latest message because the remote command handles context
    user_message = ""
    for msg in reversed(messages):
        if msg["role"] == "user":
            user_message = msg["content"]
            break

    if not user_message:
        raise ValueError("No user message found in conversation")

    # Use conversation ID as session ID. The conversation ID is spliced into
    # the same shell command as the message, so restrict it to shell-inert
    # characters (defense in depth - the frontend only ever sends simple IDs).
    session_id = f"jacarium-{re.sub(r'[^A-Za-z0-9._-]', '-', str(conversation_id))}"

    # Detect if this is a continuation of an existing conversation
    # If there are prior assistant messages, the session likely exists on the server
    has_prior_messages = any(msg.get("role") == "assistant" for msg in messages[:-1])

    # Choose the appropriate command template
    if session_id in gemini_sessions_created or has_prior_messages:
        ssh_command_template = ssh_command_followup
    else:
        ssh_command_template = ssh_command_initial
        # Mark session as created for future messages
        gemini_sessions_created.add(session_id)

    # Render the remote command. The message is passed base64-encoded and
    # decoded on the remote host - NEVER spliced raw into the shell string -
    # so shell metacharacters in a chat message (quotes, $(...), backticks,
    # $VARs from pasted log/command output) can neither break the command
    # nor execute on the SSH host. See render_ssh_ai_command.
    remote_command = render_ssh_ai_command(ssh_command_template, user_message)
    remote_command = remote_command.replace('{{SESSION_ID}}', session_id)

    # A blank command sent over exec_command doesn't fail fast -- sshd
    # typically falls back to an interactive login shell with no pty and no
    # stdin, which just hangs until the read timeout. Catch it here with a
    # clear message instead of a silent multi-minute hang.
    if not remote_command.strip():
        raise ValueError(
            "Resolved SSH command is empty. Set a command template in the "
            "SSH provider's settings (Initial/Follow-up Message Command "
            "Template) -- the example shown in those fields is only a "
            "placeholder and is not used unless you actually type it in."
        )

    try:
        import paramiko

        # Get or create SSH connection from pool
        client = get_ssh_connection(ssh_host, ssh_user, ssh_password)

        # Execute command on remote host. A pooled connection can still die
        # between the pool's liveness probe and this call (remote idle
        # timeout, sshd restart), which surfaces as a transport-level error
        # here even though the connection looked fine moments ago. In that
        # case drop the pooled connection and retry exactly once with a
        # fresh one instead of surfacing a confusing failure.
        try:
            stdin, stdout, stderr = client.exec_command(remote_command, timeout=command_timeout)
        except (paramiko.SSHException, EOFError, OSError) as exec_err:
            print(f"[SSH Chat] Pooled connection failed on exec ({exec_err}); retrying with a fresh connection")
            drop_ssh_connection(ssh_host, ssh_user)
            client = get_ssh_connection(ssh_host, ssh_user, ssh_password)
            stdin, stdout, stderr = client.exec_command(remote_command, timeout=command_timeout)

        # Read output. The channel timeout set by exec_command applies to
        # these reads too: if the remote command runs longer than
        # command_timeout without delivering output, the read raises
        # paramiko's PipeTimeout (usually surfaced as socket.timeout /
        # TimeoutError with PipeTimeout chained underneath). That is a
        # slow-remote-command condition, not a connection failure, so give
        # it a clear, actionable message instead of a generic SSH error.
        from paramiko.buffered_pipe import PipeTimeout
        try:
            response = stdout.read().decode('utf-8').strip()
            error_output = stderr.read().decode('utf-8').strip()
        except (PipeTimeout, TimeoutError):
            raise ValueError(
                f"SSH command timed out: the remote command produced no "
                f"output within {command_timeout:g} seconds. The remote AI "
                f"command may simply be slow; increase the timeout via the "
                f"SSH provider's commandTimeout setting "
                f"(SSH_AI_COMMAND_TIMEOUT) if it needs more time."
            )

        # Check for errors
        exit_status = stdout.channel.recv_exit_status()
        if exit_status != 0:
            raise ValueError(f"SSH command failed (exit {exit_status}): {error_output or 'Unknown error'}")

        if not response:
            # Check if there's any error output
            if error_output:
                raise ValueError(f"SSH command returned empty response. Error: {error_output}")
            raise ValueError("SSH command returned empty response")

        # If the command template doesn't extract the response (no jq), try parsing JSON
        if '{{MESSAGE}}' in ssh_command_template and 'jq' not in ssh_command_template:
            try:
                json_data = json.loads(response)
                response = json_data.get('response', response)
            except json.JSONDecodeError:
                # Not JSON, use raw response
                pass

        return response

    except Exception as e:
        # If it's already a ValueError, re-raise it
        if isinstance(e, ValueError):
            raise
        # Otherwise wrap it
        raise ValueError(f"SSH execution error: {str(e)}")

