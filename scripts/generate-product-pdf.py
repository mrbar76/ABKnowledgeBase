#!/usr/bin/env python3
"""Generate AB Brain product overview PDF using reportlab."""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT

OUTPUT = '/home/user/ABKnowledgeBase/AB_Brain_Product_Overview.pdf'

ACCENT = HexColor('#6366f1')
DARK = HexColor('#1e1e3c')
GRAY = HexColor('#555555')
LIGHT_GRAY = HexColor('#999999')
GREEN = HexColor('#10b981')
BG_LIGHT = HexColor('#f5f5ff')

def build():
    doc = SimpleDocTemplate(OUTPUT, pagesize=letter,
                            topMargin=0.75*inch, bottomMargin=0.75*inch,
                            leftMargin=0.85*inch, rightMargin=0.85*inch)

    styles = getSampleStyleSheet()

    # Custom styles
    styles.add(ParagraphStyle('CoverTitle', parent=styles['Title'],
        fontSize=36, textColor=DARK, alignment=TA_CENTER, spaceAfter=8, fontName='Helvetica-Bold'))
    styles.add(ParagraphStyle('CoverSub', parent=styles['Normal'],
        fontSize=16, textColor=ACCENT, alignment=TA_CENTER, spaceAfter=12))
    styles.add(ParagraphStyle('CoverDesc', parent=styles['Normal'],
        fontSize=11, textColor=LIGHT_GRAY, alignment=TA_CENTER, spaceAfter=6))
    styles.add(ParagraphStyle('SectionTitle', parent=styles['Heading1'],
        fontSize=18, textColor=DARK, fontName='Helvetica-Bold', spaceBefore=20, spaceAfter=8,
        borderWidth=2, borderColor=ACCENT, borderPadding=0))
    styles.add(ParagraphStyle('SubTitle', parent=styles['Heading2'],
        fontSize=13, textColor=HexColor('#3c3c50'), fontName='Helvetica-Bold', spaceBefore=14, spaceAfter=4))
    styles.add(ParagraphStyle('Body', parent=styles['Normal'],
        fontSize=10.5, textColor=GRAY, leading=15, spaceAfter=8))
    styles.add(ParagraphStyle('ABBullet', parent=styles['Normal'],
        fontSize=10.5, textColor=GRAY, leading=15, leftIndent=20, bulletIndent=8,
        bulletFontSize=10, spaceAfter=3))
    styles.add(ParagraphStyle('FeatureTitle', parent=styles['Normal'],
        fontSize=11, textColor=ACCENT, fontName='Helvetica-Bold', spaceAfter=2))
    styles.add(ParagraphStyle('FeatureBody', parent=styles['Normal'],
        fontSize=10, textColor=GRAY, leading=14, leftIndent=0, spaceAfter=10))
    styles.add(ParagraphStyle('SmallCenter', parent=styles['Normal'],
        fontSize=10, textColor=LIGHT_GRAY, alignment=TA_CENTER, fontName='Helvetica-Oblique'))

    story = []

    def section(title):
        story.append(Paragraph(title, styles['SectionTitle']))

    def sub(title):
        story.append(Paragraph(title, styles['SubTitle']))

    def body(text):
        story.append(Paragraph(text, styles['Body']))

    def bullet(text):
        story.append(Paragraph(text, styles['ABBullet'], bulletText='\u2022'))

    def feature(title, desc):
        story.append(Paragraph(title, styles['FeatureTitle']))
        story.append(Paragraph(desc, styles['FeatureBody']))

    def space(h=0.2):
        story.append(Spacer(1, h * inch))

    # ─── COVER ───
    space(2.0)
    story.append(Paragraph('AB Brain', styles['CoverTitle']))
    story.append(Paragraph('Personal Knowledge & Productivity System', styles['CoverSub']))
    space(0.3)
    story.append(Paragraph('Your second brain for tasks, knowledge, fitness, and daily execution.', styles['CoverDesc']))
    story.append(Paragraph('One app to capture everything, surface what matters, and close your rings.', styles['CoverDesc']))
    space(2.0)
    story.append(Paragraph('Product Overview  |  v1.7.0  |  April 2026', styles['SmallCenter']))
    story.append(PageBreak())

    # ─── WHAT IS AB BRAIN ───
    section('What Is AB Brain?')
    body('AB Brain is a self-hosted personal productivity and knowledge management system '
         'designed for people who want one place to manage their tasks, capture knowledge, '
         'track fitness, and review their execution.')
    body('It combines task management, a searchable knowledge base, conversation and transcript '
         'storage, fitness tracking with recovery science, and a gamification layer that turns '
         'daily consistency into a visual habit system.')
    body('The core philosophy: <b>capture everything that matters, surface the right context when '
         'you need it, and close your rings every day.</b>')

    sub('Who Is It For?')
    body('AB Brain is built for individuals who want a unified personal operating system - '
         'not a team tool, not a project management suite. It is for someone who wants to:')
    bullet('Manage tasks with smart prioritization and focus scoring')
    bullet('Capture knowledge from conversations, AI chats, and daily life')
    bullet('Track workouts, nutrition, body metrics, and recovery')
    bullet('Review their weekly velocity and execution trends')
    bullet('Stay accountable through gamification rings, streaks, and badges')
    bullet('Access everything from one mobile-friendly progressive web app')
    story.append(PageBreak())

    # ─── CORE FEATURES ───
    section('Core Features')

    sub('1. Smart Task Management')
    body('A full task system with six views, intelligent focus scoring, and natural language input.')

    feature('Today Focus View',
        'Automatically categorizes tasks into Overdue, Due Today, In Progress, Stale, and Waiting On. '
        'A "Top 3 Focus" algorithm scores every open task by priority, due urgency, and staleness to '
        'surface the three most important things to work on right now.')

    feature('Quick-Add with Natural Language',
        'A single-line input bar at the top of the Today view. Type "Call dentist friday high #personal" '
        'and it parses the due date, priority, and context automatically. Supports "tomorrow", day names, '
        '"every monday" for recurring tasks, and !/!! for priority. Ctrl+N focuses it from anywhere.')

    feature('Recurring Tasks',
        'Create daily, weekly, or monthly recurring tasks. Weekly tasks support day-of-week selection '
        '(e.g., Mon/Wed/Fri). The system auto-generates task instances for the next 30 days and a '
        'background job extends the horizon every 6 hours. Stop recurrence anytime.')

    feature('Task Reminders (Push Notifications)',
        'Set a push notification reminder on any task: "In 1 hour", "In 3 hours", "Tomorrow 9am", or '
        'a custom date/time. Uses Web Push with VAPID keys. Reminders fire even when the app is closed.')

    feature('Weekly Review',
        'A dedicated Review tab showing: tasks completed vs created, daily activity bar chart, '
        'completion streak, carry-over count, priority and context breakdowns, and week-over-week '
        'velocity change. Navigate to past weeks to spot trends.')

    feature('Bulk Operations',
        'Multi-select mode in the List view. Select tasks with checkboxes, then bulk Mark Done, '
        'Reschedule, Change Priority, or Delete. Includes Select All and a sticky action bar.')

    feature('Related Context',
        'Open any task and click "Find related" to auto-discover transcripts, knowledge entries, '
        'and AI conversations connected to that task. Uses PostgreSQL full-text search with relevance '
        'ranking. Pin important items permanently so context is always one click away.')

    feature('Additional Views',
        'List view with filters (status, priority, context) and multi-field sorting. Kanban board '
        'with drag-and-drop. Calendar view showing tasks by due date. Waiting On view grouped by '
        'person with wait time tracking.')

    story.append(PageBreak())

    # ─── KNOWLEDGE ───
    sub('2. Knowledge Base (Brain)')
    body('A searchable repository of everything you know and learn. Entries can be created manually, '
         'extracted from AI conversations, or imported from external sources.')
    bullet('Full-text search with PostgreSQL tsvector indexing and trigram matching')
    bullet('Categories, tags, AI source tracking, and confirmation status')
    bullet('Supports knowledge from ChatGPT, Claude, Bee wearable, and manual entry')
    bullet('Integrated into the Related Context system - knowledge surfaces inside relevant tasks')

    sub('3. Transcripts')
    body('Captures and stores conversation transcripts from the Bee AI wearable and other sources. '
         'Each transcript includes a title, summary, raw text, speaker identification, duration, '
         'location, and timestamps.')
    bullet('Automatic sync from Bee wearable every 30 minutes (zero maintenance)')
    bullet('Speaker identification and renaming')
    bullet('Full-text searchable across all transcript content')
    bullet('Surfaces automatically when relevant to a task')

    sub('4. AI Conversations')
    body('Import and store full conversation threads from ChatGPT, Claude, and other AI assistants. '
         'Each conversation preserves the complete message history, model used, and metadata.')
    bullet('Import from ChatGPT and Claude exports')
    bullet('Full thread preservation with message-by-message display')
    bullet('Summaries and tags for organization')
    bullet('Searchable and linkable to tasks')

    story.append(PageBreak())

    # ─── FITNESS ───
    sub('5. Fitness & Recovery Tracking')
    body('A comprehensive fitness layer tracking workouts, nutrition, body composition, and recovery.')

    feature('Workouts',
        'Log any workout type: strength, cardio, hybrid, hiking, sport, etc. Track exercises with '
        'sets, reps, and weights. Record effort (1-10), duration, distance, elevation, heart rate, '
        'pace, cadence, calories, and body feedback (grip, legs, cardio, shoulders).')

    feature('Nutrition',
        'Log meals with calories, protein, carbs, fat, fiber, and hydration. Track by meal type. '
        'Daily and weekly summaries with macro targets.')

    feature('Body Metrics',
        'Track weight, body fat percentage, muscle mass, and body composition data. '
        'Trend visualization over time.')

    feature('Recovery Science',
        'Training Stress Balance (TSB) model: Acute Training Load (ATL), Chronic Training Load (CTL), '
        'and form (TSB = CTL - ATL). Integrates sleep data, muscle group freshness, and daily context '
        '(energy, mood, stress) for a complete recovery picture.')

    feature('Exercise Library',
        'Built-in exercise catalog with muscle group targeting. Gym profile support for equipment availability.')

    story.append(PageBreak())

    # ─── GAMIFICATION ───
    sub('6. Gamification System')
    body('An Apple Watch-inspired ring system that turns daily consistency into a visual game.')

    feature('Three Daily Rings',
        'Train: Hit your workout effort target. Fuel: Meet nutrition targets for protein, '
        'calories, and hydration. Recover: Log sleep quality, sleep hours, and recovery data. '
        'Each ring fills as you progress toward your daily goal.')

    feature('Streaks & Badges',
        'Consecutive-day tracking for workouts, task completion, and body metrics. '
        'Achievement badges for milestones like first workout, 7-day streak, 100 tasks completed.')

    feature('Contextual Push Notifications',
        'Scheduled notifications throughout the day: Morning Briefing, Midday Check, Post Lunch, '
        'End of Work, Evening Close. Each includes real-time ring progress and pending tasks. '
        'Smart suppression: skipped when you are already ahead of schedule.')

    sub('7. Global Search & Keyboard Shortcuts')
    body('Ctrl+K opens universal search across all entity types: knowledge, transcripts, tasks, '
         'workouts, meals, body metrics, and conversations. Results grouped by type with highlights.')
    body('Full keyboard navigation: J/K to move through lists, D to toggle done, N for new task, '
         'Enter to open, 1-6 to switch tabs, Esc to close, ? for help.')

    story.append(PageBreak())

    # ─── INTEGRATIONS ───
    section('Integrations')

    feature('Bee AI Wearable',
        'Automatic sync every 30 minutes. Captures conversation transcripts with speaker identification, '
        'duration, location, and timestamps. Creates knowledge entries and tasks from Bee data.')

    feature('ChatGPT & Claude',
        'Import full conversation exports. Preserves message history, model information, and metadata. '
        'Searchable and surfaced in task context.')

    feature('OpenAI API',
        'AI-powered smart intake processing, transcript summarization, and knowledge extraction.')

    feature('Web Push Notifications',
        'VAPID-based push notifications on mobile and desktop. Configurable schedule with contextual messages.')

    feature('Progressive Web App (PWA)',
        'Installable on any device. Service worker for offline capability. Mobile-first responsive design.')

    space(0.5)

    # ─── TECH STACK ───
    section('Technical Architecture')

    sub('Tech Stack')
    bullet('<b>Backend:</b> Node.js + Express.js')
    bullet('<b>Database:</b> PostgreSQL with full-text search (tsvector), trigram indexes, JSONB')
    bullet('<b>Frontend:</b> Vanilla JavaScript single-page application (no framework dependency)')
    bullet('<b>Push:</b> web-push library with VAPID authentication')
    bullet('<b>AI:</b> OpenAI API (GPT-4o-mini) for smart features')
    bullet('<b>Hosting:</b> Railway (Docker container) - self-hostable anywhere')
    bullet('<b>Charts:</b> Chart.js for data visualization')

    sub('Data Model')
    body('16+ PostgreSQL tables covering tasks, knowledge, transcripts, conversations, workouts, '
         'exercises, meals, body metrics, daily context, gamification, activity log, and push subscriptions. '
         '20+ RESTful API route files. Full audit trail via activity logging.')

    story.append(PageBreak())

    # ─── WHY ───
    section('Why AB Brain?')

    body('Most productivity tools solve one problem: Todoist does tasks, Notion does notes, '
         'MyFitnessPal does nutrition, Strong does workouts. You end up with six apps, none of which '
         'talk to each other, and you spend more time switching context than doing work.')
    body('AB Brain is different:')

    feature('Everything in one place',
        'Tasks, knowledge, transcripts, conversations, workouts, nutrition, and body metrics. '
        'One search finds everything. One app to open in the morning.')

    feature('Context surfaces automatically',
        'Open a task and the system finds related transcripts, knowledge, and conversations for you. '
        'No manual linking required. Your data works for you.')

    feature('Execution over planning',
        'The Today view tells you what to work on. The Top 3 Focus algorithm scores every task. '
        'The ring system makes daily consistency visible. The weekly review shows if you are getting '
        'better or just staying busy.')

    feature('You own your data',
        'Self-hosted on your own infrastructure. PostgreSQL database you control. No vendor lock-in. '
        'Your second brain belongs to you.')

    feature('Built for speed',
        'Quick-add with natural language. Keyboard shortcuts for everything. Bulk operations. '
        'Single-page app that feels instant. Zero page loads.')

    space(1.0)
    story.append(Paragraph('AB Brain - Your second brain, built for execution.', styles['SmallCenter']))

    # Build
    doc.build(story)
    print(f'PDF generated: {OUTPUT}')

if __name__ == '__main__':
    build()
