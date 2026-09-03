"""Hidden tests for batch parser with comments, blank lines, and whitespace."""
from src.batch_parser import parse_batch_items


def test_batch_with_comments_and_whitespace():
    input_text = """
    # Inventory import batch 2026-09
    101, 5
    # The following item is restocked
       
    102, 12
    
    103, 99
    # End of batch
    
    """
    items = parse_batch_items(input_text)
    expected = [
        {"item_id": 101, "quantity": 5},
        {"item_id": 102, "quantity": 12},
        {"item_id": 103, "quantity": 99},
    ]
    if items != expected:
        raise AssertionError(f"Expected {expected}, got {items}")


def test_all_empty_or_comments():
    input_text = """
    # Just comments
    # Nothing else
    
    """
    if parse_batch_items(input_text) != []:
        raise AssertionError("Expected empty list for empty/comments input")
