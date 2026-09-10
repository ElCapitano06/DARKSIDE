"""
Mental Health Check-In
-----------------------
A small interactive Python program that chats with the user about how
they're feeling, reflects it back to them, and offers gentle, practical
suggestions. It is NOT a therapist, doctor, or crisis service — it's a
simple, honest tool built to help someone pause and think about their
own state of mind for a minute.

How it "understands" you:
This program doesn't use a real AI model — it uses keyword matching
(looking for certain words/phrases in what you type) combined with
randomized, varied response templates so it doesn't feel like it's
reading from a script on repeat. That's a common and useful technique
in Python before you get into real machine learning / AI APIs.
"""

import random
import time
import textwrap


# ---------------------------------------------------------------------
# 1. Response banks
# Each category has several possible replies. We pick one at random
# each time so the conversation doesn't feel robotic or repetitive.
# ---------------------------------------------------------------------

GREETINGS = [
    "Hey, I'm glad you're here. This is just a space to check in with yourself for a minute.",
    "Hi there. No pressure, no judgment here — just a quick check-in.",
    "Welcome. Let's take a moment to see how you're actually doing today.",
]

MOOD_KEYWORDS = {
    "crisis": [
        "suicide", "kill myself", "end my life", "want to die",
        "hurt myself", "self harm", "self-harm", "no reason to live",
        "can't go on", "cant go on",
    ],
    "sad": [
        "sad", "depressed", "down", "hopeless", "empty", "crying",
        "lonely", "alone", "worthless", "numb",
    ],
    "anxious": [
        "anxious", "anxiety", "panic", "worried", "nervous", "scared",
        "overwhelmed", "on edge", "can't relax", "cant relax",
    ],
    "angry": [
        "angry", "furious", "frustrated", "irritated", "mad", "annoyed",
    ],
    "tired": [
        "tired", "exhausted", "burnt out", "burned out", "drained",
        "no energy", "can't sleep", "cant sleep",
    ],
    "good": [
        "good", "great", "fine", "happy", "okay", "ok", "well",
        "excited", "calm", "content",
    ],
}

REFLECTIONS = {
    "crisis": [
        "I'm really glad you told me that, and I want to take it seriously.",
        "Thank you for being honest about something that heavy — that matters.",
    ],
    "sad": [
        "That sounds heavy to carry around.",
        "It makes sense that would weigh on you.",
        "That kind of low feeling is exhausting, and it's okay to name it out loud.",
    ],
    "anxious": [
        "That sounds like a lot of noise in your head right now.",
        "Anxiety has a way of making everything feel urgent all at once.",
        "It sounds like your mind's been running fast lately.",
    ],
    "angry": [
        "That frustration sounds like it's been building up.",
        "Fair enough — that sounds genuinely irritating.",
    ],
    "tired": [
        "Running on empty is rough, physically and mentally.",
        "It sounds like you haven't had much room to actually rest.",
    ],
    "good": [
        "That's genuinely good to hear.",
        "Nice — I'm glad today's landing on the better side.",
    ],
    "neutral": [
        "Thanks for sharing that with me.",
        "Okay, I hear you.",
    ],
}

SUGGESTIONS = {
    "sad": [
        "Sometimes writing down the specific thing bothering you (not just the feeling) "
        "can make it feel a little less enormous.",
        "A short walk, some sunlight, or even just texting one person you trust can help, "
        "even if it doesn't fix everything.",
        "If this sadness has been sticking around for weeks rather than days, it's worth "
        "talking to a counselor or doctor — not because something's wrong with you, but "
        "because you deserve support built for this.",
    ],
    "anxious": [
        "Try the 5-4-3-2-1 grounding trick: name 5 things you see, 4 you can touch, "
        "3 you hear, 2 you smell, 1 you taste. It pulls your brain out of the spiral.",
        "Slow breathing actually works on your nervous system, not just your mood — "
        "try inhaling for 4 seconds, holding for 4, exhaling for 6.",
        "Anxiety often shrinks when it's said out loud to someone else instead of just "
        "looping in your head. A therapist or trusted friend can help with that.",
    ],
    "angry": [
        "Physical release can help — even just clenching and releasing your fists, "
        "or going for a brisk walk before responding to anything.",
        "It might help to write out exactly what happened and why it bothered you, "
        "before deciding what (if anything) to do about it.",
    ],
    "tired": [
        "Burnout usually isn't fixed by one good night of sleep — it's worth looking "
        "at what's been draining you consistently, not just today.",
        "Even 10 minutes of doing absolutely nothing, on purpose, can help reset a bit.",
    ],
    "good": [
        "Worth noticing what's contributing to that — it's useful data for the harder days.",
    ],
    "neutral": [
        "Even an 'okay' day is worth checking in on — how's your sleep and energy been lately?",
    ],
}

CRISIS_MESSAGE = """
I want to pause here for a second, because what you shared sounds serious,
and I care about your safety more than finishing this chat.

I'm just a simple program — I can't provide real support, but real people can:

  • If you're in immediate danger, please call your local emergency number right now.
  • In the US: call or text 988 (Suicide & Crisis Lifeline), available 24/7.
  • Outside the US: findahelpline.com lists crisis lines by country.

If you're able to, please reach out to one of those, or to someone you trust,
right now — not later. You don't have to carry this alone.
"""

CLOSERS = [
    "Thanks for being honest with a simple little Python script — that's not nothing.",
    "That's it from me for now. Be a little gentle with yourself today.",
    "Take care of yourself out there. This chat isn't a substitute for real support, "
    "but I hope it helped even a little.",
]


# ---------------------------------------------------------------------
# 2. Helper functions
# ---------------------------------------------------------------------

def slow_print(text, delay=0.015):
    """Prints text with a slight typing effect so it feels less like a
    wall of robotic output dumped all at once."""
    for char in text:
        print(char, end="", flush=True)
        time.sleep(delay)
    print()


def detect_mood(user_text):
    """Looks for keywords in the user's text and returns the matching
    mood category. Crisis language is checked FIRST and always wins,
    regardless of what else is in the sentence."""
    text = user_text.lower()

    for phrase in MOOD_KEYWORDS["crisis"]:
        if phrase in text:
            return "crisis"

    for mood, keywords in MOOD_KEYWORDS.items():
        if mood == "crisis":
            continue
        for phrase in keywords:
            if phrase in text:
                return mood

    return "neutral"


def respond_to_mood(mood):
    """Prints a reflection and, unless it's a crisis, a suggestion —
    each pulled randomly from the response banks above."""
    reflection = random.choice(REFLECTIONS[mood])
    slow_print(reflection)

    if mood == "crisis":
        slow_print(CRISIS_MESSAGE)
        return

    suggestion = random.choice(SUGGESTIONS[mood])
    print()
    slow_print(textwrap.fill(suggestion, width=80))


# ---------------------------------------------------------------------
# 3. Main conversation flow
# ---------------------------------------------------------------------

def main():
    print("=" * 60)
    slow_print("MENTAL HEALTH CHECK-IN  (a simple Python program, not a therapist)")
    print("=" * 60)
    print()

    slow_print(random.choice(GREETINGS))
    print()

    name = input("What should I call you? ").strip() or "friend"
    print()

    slow_print(f"Good to meet you, {name}.")
    time.sleep(0.3)

    while True:
        print()
        user_input = input(f"{name}, how are you actually doing today? ").strip()

        if not user_input:
            slow_print("Take your time — even a few words is fine.")
            continue

        if user_input.lower() in ("quit", "exit", "bye", "done"):
            break

        print()
        mood = detect_mood(user_input)
        respond_to_mood(mood)

        if mood == "crisis":
            # After a crisis message, don't casually continue the small-talk
            # loop as if nothing happened — end gently instead.
            print()
            slow_print("I'm going to stop the check-in here so that message "
                        "doesn't get lost in more chat. Please reach out to "
                        "one of those resources. Take care of yourself.")
            return

        print()
        again = input("Want to talk about anything else? (yes/no) ").strip().lower()
        if again not in ("y", "yes"):
            break

    print()
    slow_print(random.choice(CLOSERS))


if __name__ == "__main__":
    main()
