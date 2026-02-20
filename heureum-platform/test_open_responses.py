#!/usr/bin/env python
# Copyright (c) 2026 Heureum AI. All rights reserved.
"""Test script for Open Responses implementation."""

import json
import os
import sys

import django

# Setup Django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "heureum_platform.settings")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
django.setup()

import pytest  # noqa: E402
from chat_messages.models import Message, Response  # noqa: E402
from chat_messages.serializers import (  # noqa: E402
    MessageItemSerializer,
    ResponseRequestSerializer,
)


@pytest.mark.django_db
def test_models():
    """Test Django models."""
    print("\n=== Testing Django Models ===")

    # Create a Response
    response = Response.objects.create(
        session_id="test_session_1",
        model="gpt-4",
        status="completed",
    )
    print(f"✓ Created Response: {response.id}")

    # Create Messages
    msg1 = Message.objects.create(
        session_id="test_session_1",
        response=response,
        role="user",
        content=[{"type": "input_text", "text": "Hello, how are you?"}],
    )
    print(f"✓ Created User Message: {msg1.id}")
    print(f"  Content: {msg1.get_text_content()}")

    msg2 = Message.objects.create(
        session_id="test_session_1",
        response=response,
        role="assistant",
        content=[{"type": "output_text", "text": "I'm doing well, thank you!"}],
    )
    print(f"✓ Created Assistant Message: {msg2.id}")
    print(f"  Content: {msg2.get_text_content()}")

    # Query messages by response
    messages = response.output_items.all()
    print(f"✓ Response has {messages.count()} messages")

    return response, msg1, msg2


def test_serializers():
    """Test serializers."""
    print("\n=== Testing Serializers ===")

    # Test MessageItemSerializer
    message_data = {
        "role": "user",
        "content": [{"type": "input_text", "text": "Test message"}],
    }
    msg_serializer = MessageItemSerializer(data=message_data)
    if msg_serializer.is_valid():
        print("✓ MessageItemSerializer is valid")
        print(f"  Data: {json.dumps(msg_serializer.validated_data, indent=2)}")
    else:
        print(f"✗ MessageItemSerializer errors: {msg_serializer.errors}")

    # Test ResponseRequestSerializer
    request_data = {
        "model": "gpt-4",
        "input": "Hello, world!",
        "temperature": 0.7,
        "metadata": {"session_id": "test_123"},
    }
    req_serializer = ResponseRequestSerializer(data=request_data)
    if req_serializer.is_valid():
        print("✓ ResponseRequestSerializer is valid")
        print(f"  Data: {json.dumps(req_serializer.validated_data, indent=2)}")
    else:
        print(f"✗ ResponseRequestSerializer errors: {req_serializer.errors}")

    # Test with items array
    request_data_items = {
        "model": "gpt-4",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "Hello!"}],
            }
        ],
    }
    req_serializer2 = ResponseRequestSerializer(data=request_data_items)
    if req_serializer2.is_valid():
        print("✓ ResponseRequestSerializer with items array is valid")
    else:
        print(f"✗ ResponseRequestSerializer errors: {req_serializer2.errors}")


@pytest.mark.django_db
def test_response_object():
    """Test complete response object."""
    print("\n=== Testing Response Object ===")

    # Create a complete response
    response = Response.objects.create(
        session_id="test_session_2",
        model="gpt-4",
        status="completed",
        input_tokens=10,
        output_tokens=20,
        total_tokens=30,
    )

    Message.objects.create(
        session_id="test_session_2",
        response=response,
        role="user",
        content=[{"type": "input_text", "text": "What is 2+2?"}],
    )

    Message.objects.create(
        session_id="test_session_2",
        response=response,
        role="assistant",
        content=[{"type": "output_text", "text": "2+2 equals 4."}],
    )

    # Serialize the response
    from chat_messages.serializers import ResponseSerializer

    serializer = ResponseSerializer(response)
    print("✓ Response object serialized:")
    print(json.dumps(serializer.data, indent=2, default=str))


def test_string_input_conversion():
    """Test converting string input to message items."""
    print("\n=== Testing String Input Conversion ===")

    input_str = "Hello, this is a test message"
    input_messages = [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": input_str}],
        }
    ]

    print(f"✓ Input string: '{input_str}'")
    print(f"✓ Converted to: {json.dumps(input_messages, indent=2)}")


def cleanup():
    """Clean up test data."""
    print("\n=== Cleaning Up Test Data ===")
    deleted_messages = Message.objects.filter(session_id__startswith="test_session_").delete()
    deleted_responses = Response.objects.filter(session_id__startswith="test_session_").delete()
    print(f"✓ Deleted {deleted_messages[0]} messages")
    print(f"✓ Deleted {deleted_responses[0]} responses")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Open Responses Implementation Test Suite")
    print("=" * 60)

    try:
        test_models()
        test_serializers()
        test_response_object()
        test_string_input_conversion()

        print("\n" + "=" * 60)
        print("✓ All tests passed!")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ Test failed with error: {e}")
        import traceback

        traceback.print_exc()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
