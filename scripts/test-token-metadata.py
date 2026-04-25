#!/usr/bin/env python3
"""
Test script to verify LM Studio API token usage metadata availability
This script uses only Python standard library - no external dependencies required.
"""

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime

# Configuration
HOST = "localhost"
PORT = 1234
BASE_URL = f"http://{HOST}:{PORT}"

def print_header(text):
    """Print a formatted header."""
    print(f"\n{'='*50}")
    print(f"{text}")
    print('='*50)

def print_subheader(text):
    """Print a formatted sub-header."""
    print(f"\n{text}")
    print('-'*len(text))

def make_request(endpoint, method="GET", data=None, timeout=10):
    """Make an HTTP request and return the response as JSON or string."""
    url = f"{BASE_URL}{endpoint}"
    
    try:
        if data:
            data_bytes = json.dumps(data).encode('utf-8')
            req = urllib.request.Request(url, data=data_bytes, method=method)
            req.add_header('Content-Type', 'application/json')
        else:
            req = urllib.request.Request(url, method=method)
        
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8')) if response.headers.get('Content-Type', '').startswith('application/json') else response.read().decode('utf-8'), None
            
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.fp else "No body"
        return None, f"HTTP {e.code}: {e.reason}\n{error_body[:200]}"
    except urllib.error.URLError as e:
        return None, f"URL Error: {e.reason}"
    except json.JSONDecodeError as e:
        return None, f"JSON Parse Error: {e}"
    except Exception as e:
        return None, f"Unexpected error: {type(e).__name__}: {e}"

def test_non_streaming():
    """Test non-streaming chat completion for usage metadata."""
    print_subheader("Test 1: Non-streaming Chat Completion")
    
    request_data = {
        "model": "test-model",
        "messages": [
            {"role": "user", "content": "Hello, this is a test message for token counting calibration."}
        ],
        "stream": False
    }
    
    response, error = make_request("/v1/chat/completions", method="POST", data=request_data)
    
    if error:
        print(f"❌ FAILED: Could not connect to LM Studio at {BASE_URL}")
        print(f"Error: {error}")
        return False
    
    # Check for usage metadata
    if 'usage' in response and response['usage']:
        print("✅ SUCCESS: Usage metadata found in non-streaming response")
        print("\nUsage data:")
        usage = response['usage']
        print(f"  prompt_tokens: {usage.get('prompt_tokens', 'N/A')}")
        print(f"  completion_tokens: {usage.get('completion_tokens', 'N/A')}")
        print(f"  total_tokens: {usage.get('total_tokens', 'N/A')}")
        
        # Store for later use
        return {'success': True, 'usage': usage}
    else:
        print("❌ FAILED: No usage metadata in non-streaming response")
        print("\nFull response:")
        print(json.dumps(response, indent=2))
        return False

def test_streaming():
    """Test streaming chat completion for usage metadata."""
    print_subheader("Test 2: Streaming Chat Completion")
    
    request_data = {
        "model": "test-model",
        "messages": [
            {"role": "user", "content": "Hello, this is a test message."}
        ],
        "stream": True
    }
    
    url = f"{BASE_URL}/v1/chat/completions"
    data_bytes = json.dumps(request_data).encode('utf-8')
    req = urllib.request.Request(url, data=data_bytes, method="POST")
    req.add_header('Content-Type', 'application/json')
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            lines = []
            for line in response:
                line_str = line.decode('utf-8').strip()
                if line_str.startswith('data:'):
                    data_content = line_str[5:].strip()
                    if data_content and data_content != '[DONE]':
                        try:
                            parsed = json.loads(data_content)
                            lines.append(parsed)
                        except json.JSONDecodeError:
                            pass
            
            # Check last event for usage metadata
            if lines:
                last_event = lines[-1]
                if 'usage' in last_event and last_event['usage']:
                    print("✅ SUCCESS: Usage metadata found in final streaming chunk")
                    print("\nUsage data from last chunk:")
                    usage = last_event['usage']
                    print(f"  prompt_tokens: {usage.get('prompt_tokens', 'N/A')}")
                    print(f"  completion_tokens: {usage.get('completion_tokens', 'N/A')}")
                    print(f"  total_tokens: {usage.get('total_tokens', 'N/A')}")
                else:
                    print("⚠️  WARNING: No usage metadata in final streaming chunk")
                    if lines[-1].get('choices'):
                        finish_reason = lines[-1]['choices'][0].get('finish_reason')
                        if finish_reason == 'stop' or finish_reason == 'length':
                            print("\nStream completed normally, but usage metadata may not be included in SSE format.")
            else:
                print("⚠️  WARNING: No events received in stream")
                
    except Exception as e:
        print(f"❌ FAILED: Error during streaming test: {type(e).__name__}: {e}")

def test_model_metadata():
    """Test model metadata availability."""
    print_subheader("Test 3: Model Metadata Check")
    
    response, error = make_request("/v1/models", method="GET")
    
    if error:
        print(f"❌ FAILED: Could not fetch models list from {BASE_URL}/v1/models")
        print(f"Error: {error}")
        return False
    
    if 'data' in response and len(response['data']) > 0:
        print("✅ SUCCESS: Models endpoint accessible")
        print("\nAvailable models:")
        for model in response['data'][:5]:  # Show first 5 models
            model_id = model.get('id', 'Unknown')
            model_name = model.get('name', model.get('id', 'No name'))
            max_context = model.get('max_context_length', 'Not provided')
            print(f"  - {model_id} ({model_name})")
            print(f"    Max context: {max_context}")
        
        return True
    else:
        print("⚠️  WARNING: Could not retrieve models list or empty response")
        return False

def test_native_api():
    """Test native LM Studio API endpoint."""
    print_subheader("Test 4: Native LM Studio API Check")
    
    response, error = make_request("/api/v0/models", method="GET")
    
    if error:
        print(f"❌ FAILED: Could not connect to native API at {BASE_URL}/api/v0/models")
        print(f"Error: {error}")
        return False
    
    if 'data' in response and len(response['data']) > 0:
        print("✅ SUCCESS: Native API endpoint accessible")
        
        model = response['data'][0]
        print("\nModel metadata fields available:")
        for key, value in list(model.items())[:10]:  # Show first 10 fields
            if isinstance(value, (dict, list)):
                value_str = json.dumps(value)[:50] + "..."
            else:
                value_str = str(value)
            print(f"  - {key}: {value_str}")
        
        arch = model.get('arch', 'Not provided')
        print(f"\nModel architecture (family): {arch}")
        return True
    else:
        print("⚠️  WARNING: Native API endpoint returned empty response")
        return False

def main():
    """Main test execution."""
    print_header("LM Studio Token Usage Metadata Test")
    print(f"Testing against: {BASE_URL}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    results = {}
    
    # Run tests
    result1 = test_non_streaming()
    if isinstance(result1, dict):
        results['non_streaming'] = result1
    
    test_streaming()
    results['streaming'] = True  # Just mark as attempted
    
    result3 = test_model_metadata()
    results['model_metadata'] = result3
    
    result4 = test_native_api()
    results['native_api'] = result4
    
    # Summary and recommendations
    print_header("Test Summary")
    
    if 'non_streaming' in results and isinstance(results['non_streaming'], dict) and results['non_streaming'].get('success'):
        print("✅ CALIBRATION FEASIBLE: Non-streaming mode provides usage metadata")
        print("\nRecommendation:")
        print("  - Use non-streaming mode (stream: false) for calibration data collection")
        print("  - Streaming mode can be used for actual completions but won't provide usage data")
        print("  - Implement dual-mode approach: streaming for UX, non-streaming sampling for calibration")
    else:
        print("❌ CALIBRATION NOT FEASIBLE: No usage metadata available in responses")
        print("\nRecommendation:")
        print("  - Family-based estimation must be used without calibration")
        print("  - Consider implementing manual calibration command where users input observed token counts")
    
    # Save results to file for later analysis
    output_file = "/tmp/lmstudio-token-test-results.json"
    with open(output_file, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'base_url': BASE_URL,
            'results': results
        }, f, indent=2)
    
    print(f"\nTest results saved to: {output_file}")

if __name__ == "__main__":
    main()
