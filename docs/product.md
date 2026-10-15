# Relay Product Plan V1.0

<p align="center">
  <img src="../assets/brand/relay-logo.svg" alt="Relay logo" width="360">
</p>

Relay — The control plane for your AI workforce

An enterprise Workforce Intelligence Platform for the AI era.
Goal: maximize user productivity and value creation, not replace users.

| Dimension | Content |
| :-: | :-: |
| Document Type | Product Plan |
| Product Name | Relay |
| Version | V1.0 |
| Core Positioning | AI Workforce Intelligence Platform |
| Core Principle | Amplify users, not replace users |

This document defines Relay's product direction: target users, market thesis, positioning, scenarios, capability system, business model, roadmap, and product risks. It should stay focused on product planning and product strategy.

For technical architecture, see [system-architecture.md](system-architecture.md). For build-level implementation details, see [implementation-plan.md](implementation-plan.md).

---

## Table of Contents

1. Executive Summary
2. Product Background and Market Opportunity
3. Relay Product Positioning
4. Core Users and Use Cases
5. Deep-Dive Scenarios: From Transaction Processing to Value Creation
6. Product Capability System
7. Differentiation and Competitive Strategy
8. Business Value and ROI Model
9. Business Model and Customer Adoption Path
10. Product Roadmap
11. Risks, Boundaries, and Governance
12. Conclusion

---

## 1. Executive Summary

| |
| :-: |
| Relay's core proposition: give every user a long-term AI Partner that frees time from transactional work and redirects it toward customer value, business innovation, and organizational capability building. |

Relay is a next-generation Workforce Intelligence Platform for enterprises in the AI era. It is not a simple chatbot, enterprise knowledge base, or agent development platform. It provides an AI Partner that continuously learns, collaborates, and executes around real user workflows.

Relay is designed to amplify users, not replace them. It helps high-value users reduce low-value transactional work, gives every user access to expert-level support, and turns knowledge held by individuals into reusable organizational capability.

| Dimension | Content |
| :-: | :-: |
| One-line Definition | Relay gives every user an AI Partner that connects organizational knowledge, business workflows, and professional capabilities so users can create value faster. |
| Target Users | Sales, customer success, product managers, engineering, project managers, consultants, training teams, and managers. |
| Core Value | Improve user productivity, increase knowledge reuse, capture expert experience, reduce collaboration friction, and increase customer value creation. |
| Initial Entry Scenarios | Sales value creation, product and engineering collaboration, customer success operations, organizational knowledge assistance, and expert experience capture. |
| Long-term Vision | Evolve from Personal Relay to Team Relay and Organization Relay, forming an enterprise organizational intelligence network. |

### 1.1 Document Boundary

This product plan answers:

- Who Relay serves.
- Which pain points Relay prioritizes.
- Which scenarios create early business value.
- Which capabilities make the product differentiated.
- How Relay should enter the market and expand.
- Which product risks must be controlled.

This product plan does not define service topology, database schema, sandbox implementation, workflow APIs, or infrastructure deployment. Those decisions belong in the architecture and technical implementation documents.

## 2. Product Background and Market Opportunity

### 2.1 Enterprise Workforces Are Changing in the AI Era

Historically, enterprise digitization focused on moving processes into systems: CRM managed customers, ERP managed operations, OA managed approvals, LMS managed training, and wikis managed knowledge. These systems still depend on users to enter data, search for information, and coordinate work manually.

AI agents create the first real opportunity to turn information inside systems into executable work capability. Users should no longer need to switch constantly across systems. Instead, they can work through an AI Partner that understands the business, carries the right context, respects permission boundaries, and helps with information retrieval, task coordination, content generation, and process follow-up.

| |
| :-: |
| Enterprises buy Relay not because they want "agents," but because they want users to create more value in the same amount of time. |

### 2.2 Gaps in Existing Enterprise AI Tools

| Existing Category | Primary Capability | Limitation | Relay Entry Point |
| :-: | :-: | :-: | :-: |
| General LLMs / ChatGPT-like tools | Q&A, writing, analysis | Lack enterprise context, permissions, long-term memory, and task closure | Build long-term AI Partners around user roles and business scenarios |
| Copilot-style tools | Improve productivity inside office applications | Mostly focused on documents, email, and meetings; weak cross-system execution | Connect knowledge, workflows, tools, and collaborators |
| Enterprise knowledge bases / RAG | Query documents and policies | Answer questions but rarely move work forward | Upgrade from "knowing" to "executing and capturing" |
| Agent development platforms | Build tool calls and automation flows | Technical-platform oriented; business users struggle to see direct value | Deliver product value through frequent, high-ROI business scenarios |

### 2.3 The Enterprise Pain Is Not Tool Shortage, but Low-Value Work Consuming High-Value Users

Most knowledge workers do not spend most of their time creating value. Their work is fragmented by transactional tasks: looking up information, writing summaries, sending emails, syncing progress, chasing follow-ups, entering system data, and preparing reports. Relay's opportunity is to shift this work to an AI Partner so users can return to work that directly creates value.

## 3. Relay Product Positioning

### 3.1 Product Positioning

| |
| :-: |
| Relay = The AI Partner for Every User. |

Relay is an enterprise Workforce Intelligence Platform. It connects users, organizational knowledge, business workflows, internal systems, and AI agents into a new Human + AI way of working.

| Dimension | Content |
| :-: | :-: |
| What Relay Is Not | Not a simple AI chatbot; not only a knowledge base; not a developer-centered agent platform; not a workforce-reduction tool. |
| What Relay Is | A business-scenario-oriented user AI Partner that helps users complete work, coordinate collaboration, capture experience, and create value. |
| Core Idea | Every User. Amplified. |
| Enterprise Benefit | The same talent base creates more customer value, business value, and organizational capability. |

### 3.2 Product North Star Metrics

| Metric | Definition | Business Meaning |
| :-: | :-: | :-: |
| Value Creation Time Ratio | Share of user time spent on high-value work such as customers, innovation, and decisions | Measures whether Relay truly frees user time |
| Task Completion Rate | Completion rate of tasks involving Relay | Measures the shift from Q&A to execution |
| Knowledge Reuse Rate | Frequency of reused historical knowledge, cases, and experience | Measures the efficiency of organizational knowledge flow |
| Collaboration Friction Reduction | Reduction in cross-functional sync, chasing, and repeated communication | Measures collaboration cost reduction |
| User Adoption and Trust | Active usage, retention, and depth of authorization | Measures whether Relay is treated as a partner rather than a tool |

## 4. Core Users and Use Cases

| User Role | Main Pain Point | Relay Value | Priority |
| :-: | :-: | :-: | :-: |
| Sales / Account Managers | Customer information is scattered, CRM entry is tedious, and internal coordination is slow | Increase customer-facing time and automate pre-meeting and post-meeting work | P0 |
| Customer Success | Customer health is hard to monitor and renewal risk is discovered late | Proactively identify risk and expansion opportunities, then generate action recommendations | P0 |
| Product Managers | Requirements are scattered, PRDs are repetitive, and project tracking is time-consuming | Cluster requirements, draft documents, and track engineering risks | P0 |
| Engineers | Context switching, complex codebases, and bug localization consume time | Connect Claude Code, Codex, and similar tools to execute code analysis and fixes | P1 |
| Consultants / Professional Services | Historical cases are underused and report production is slow | Generate delivery drafts and methodology recommendations from case libraries | P1 |
| HR / Training Leads | Training outcomes are hard to quantify and expert experience is hard to replicate | Connect learning, practice, and work behavior into capability models | P1 |
| Middle Managers | Team progress is opaque and status collection is time-consuming | Generate team status, risks, and resource bottleneck views automatically | P1 |

## 5. Deep-Dive Scenarios: From Transaction Processing to Value Creation

### 5.1 Scenario 1: Sales Value Creation Assistant

#### Current Problems

- Customer information is spread across CRM, email, instant messaging, meeting notes, and contract systems.
- Sales teams spend significant time on CRM entry, meeting notes, follow-up emails, and internal coordination.
- New salespeople struggle to learn the customer management methods used by top performers.

#### Relay Workflow

| Stage | Sales Action | Relay Action | Output |
| :-: | :-: | :-: | :-: |
| Before Meeting | Prepare for a customer meeting | Summarize customer background, historical communications, contracts, product usage, risks, and opportunities | Customer brief, meeting recommendations, key question list |
| During Meeting | Talk with the customer | Record the meeting and extract needs, budget, decision chain, objections, and next steps | Structured meeting notes |
| After Meeting | Advance the opportunity | Update CRM, generate follow-up emails, and notify solution, product, or legal stakeholders | CRM records, emails, internal tasks |
| Long Term | Manage the account | Continuously track customer health, competitor signals, renewal risks, and expansion opportunities | Customer action recommendations |

#### Differentiation

- Relay does not merely help salespeople write an email; it helps them complete the customer management loop.
- Relay is not only a personal sales tool; it turns sales experience into reusable team assets.
- By binding Agent ID to user permissions, Relay can execute work while preserving approval and accountability boundaries.

#### Business Value

- Increase the share of time sales teams spend with customers.
- Shorten new sales ramp-up cycles.
- Reduce missing CRM data and improve sales forecast accuracy.
- Capture high-performing sales playbooks and improve overall team conversion.

### 5.2 Scenario 2: Product and Engineering Collaboration Assistant

#### Current Problems

- Requirements come from customers, sales, operations, data, support, and other channels, making aggregation difficult.
- Product managers spend large amounts of time preparing materials, writing PRDs, tracking engineering progress, and syncing status.
- Historical decision context is often lost, causing repeated discussion and recurring debate.

#### Relay Workflow

| Task | Relay Capability | Value |
| :-: | :-: | :-: |
| Requirement Clustering | Extract and cluster requirements from customer feedback, tickets, meetings, and IM | Identify frequent and high-value needs |
| PRD Drafting | Generate background, user stories, business rules, acceptance criteria, and risks from templates | Reduce document drafting time |
| Engineering Tracking | Connect Jira, Git, CI, and test systems to identify delays, blockers, and quality risks | Reduce manual status sync |
| Release Notes | Generate release notes from requirements, commits, and test results | Improve release transparency |
| Historical Decision Trace | Answer "why did we not do this then?" and "why was it designed this way?" | Avoid repeated debate |

#### Business Value

- Move product managers from document administration toward user insight and product innovation.
- Increase requirement delivery speed and cross-functional collaboration efficiency.
- Capture product decision assets and reduce context loss from personnel changes.

### 5.3 Scenario 3: Customer Success and Renewal Growth Assistant

#### Current Problems

- Customer risks are often discovered only shortly before renewal.
- Customer success managers must manually review product usage data, tickets, meetings, and emails.
- Customer management actions are inconsistent and depend heavily on individual experience.

#### Relay Workflow

| Capability | Description | Output |
| :-: | :-: | :-: |
| Customer Health Monitoring | Connect product usage, tickets, meeting frequency, satisfaction, and commercial information | Health score and risk level |
| Renewal Risk Alerts | Identify signals such as declining usage, key contact departure, and increased complaints | Risk alerts and action recommendations |
| Expansion Opportunity Detection | Combine department growth, feature usage, and historical communications to identify opportunities | Upsell recommendations |
| QBR Support | Automatically generate quarterly business review materials | QBR report draft |

#### Business Value

- Improve renewal rate and customer lifetime value.
- Shift customer success from reactive response to proactive account management.
- Turn strong CSM practices into standardized playbooks.

### 5.4 Scenario 4: Organizational Knowledge Assistant

#### Current Problems

- Knowledge is scattered across multiple systems, and users do not know where to look.
- Knowledge bases are often outdated and lack context.
- The same questions repeatedly appear across teams.

#### Relay Workflow

- Connect documents, IM, email, CRM, project management systems, and training systems.
- Answer not only "what does the document say?" but also "why was this decision made, who has done it before, and what was the result?"
- Turn frequent questions, key decisions, and best practices into organizational memory.

#### Business Value

- Reduce time spent searching for knowledge.
- Reduce repeated discussion and repeated mistakes.
- Help new users work independently faster.

### 5.5 Scenario 5: Expert Experience Capture and Capability Replication

#### Current Problems

- The experience of star salespeople, senior consultants, architects, and strong product managers is difficult to make explicit.
- Traditional training can pass on knowledge points but struggles to convey real work judgment.
- When users leave, experience, customer background, and decision logic are easily lost.

#### Relay Workflow

- Continuously record expert project processes, communication patterns, decision rationales, and deliverables.
- Extract reusable patterns, templates, cases, and action recommendations from real work.
- Create Expert Relay capabilities that give new users expert-level guidance inside concrete work.

#### Business Value

- Convert individual capability into organizational capability.
- Shorten new user training cycles.
- Reduce key-person risk.

## 6. Product Capability System

### 6.1 Three Product Forms

| Layer | Target | Core Capabilities | Value |
| :-: | :-: | :-: | :-: |
| Personal Relay | Every user | Personal work assistant, knowledge assistant, task execution, personal memory | Improve individual productivity and value creation |
| Team Relay | Teams / departments | Team status, cross-person collaboration, project risks, best practices | Improve team collaboration efficiency |
| Organization Relay | Enterprise / organization | Organizational knowledge, experience assets, capability graph, governance analytics | Build organizational intelligence |

### 6.2 Core Functional Modules

| Module | Function | Scenario Support |
| :-: | :-: | :-: |
| Relay Identity | Bind user ID and Agent ID, inheriting role, department, job function, and permission boundaries | Personal assistant, authorized execution, audit |
| Work Memory | Record tasks, meetings, documents, decisions, project experience, and preferences | Knowledge capture, expert experience replication |
| Knowledge Connector | Connect documents, IM, email, CRM, project systems, and LMS | Organizational knowledge assistant |
| Task Orchestration | Break complex tasks into planning, execution, checking, and delivery | Sales, product, customer success |
| Tool and MCP Gateway | Connect enterprise tools and external systems through MCP, CLI, and APIs | Cross-system execution |
| Sandbox Runtime | Provide isolated execution environments for Claude Code, Codex, Pi Agent, and similar tools | Engineering, data, automation tasks |
| Human-in-the-loop | Require user confirmation or approval for critical actions | Risk control |
| Analytics Dashboard | Analyze productivity gains, knowledge reuse, agent contribution, and adoption | Management proof of value |

### 6.3 Agent Execution Boundaries

Relay must clearly separate recommended actions, automatically executable actions, and actions that require human approval. This is the foundation of enterprise trust and a prerequisite for scalable deployment.

| Action Type | Examples | Execution Policy |
| :-: | :-: | :-: |
| Recommended | Generate emails, summarize meetings, analyze customer risk | Can be generated directly and used after user confirmation |
| Low-risk Execution | Update non-critical fields, create tasks, organize materials | Can execute automatically after authorization, with audit records retained |
| High-risk Execution | Send official quotes, approve contracts, delete data, make external commitments | Requires human approval |

## 7. Differentiation and Competitive Strategy

### 7.1 Relay's Core Differentiation

Relay's differentiation is not "how many agents it has," but whether it can connect user work, organizational knowledge, and value creation into a closed loop.

| Dimension | Ordinary AI Assistant | Agent Development Platform | Relay |
| :-: | :-: | :-: | :-: |
| Starting Point | Answer questions | Build automated agents | User value creation |
| Users | Individual or office users | Developers / technical teams | Business users, team managers, enterprise leaders |
| Core Result | Content generation | Tool calls | Work completion, knowledge capture, experience reuse |
| Context | Short-term conversation | Task context | Long-term user context + organizational context |
| Organizational Value | Limited | Depends on development capability | Builds organizational intelligence |

### 7.2 Avoid the "User Replacement" Narrative

Relay's brand and sales narrative should avoid words such as layoff, replacement, or digital users replacing people. The correct narrative is that Relay helps users become Super Users, enabling the same teams to produce higher-quality, faster, and more customer-valuable outcomes.

- For users: Relay is a work partner, not a competitor.
- For managers: Relay is a team accelerator, not a surveillance tool.
- For enterprises: Relay is organizational intelligence infrastructure, not a point productivity tool.

## 8. Business Value and ROI Model

### 8.1 Value Creation Model

| Value Dimension | Measurement | Example |
| :-: | :-: | :-: |
| Time Released | Hours of transactional work saved per user per week | Sales post-meeting entry and follow-up reduced by 3 hours per week |
| Revenue Increase | Changes in sales conversion, renewal rate, and expansion rate | Customer success identifies renewal risks earlier |
| Innovation Speed | Cycle time from requirement discovery to delivery | Product requirement analysis and documentation cycle shortened |
| Knowledge Reuse | Reuse count for historical cases, templates, and decision records | Consultants reuse historical delivery plans |
| New User Ramp-up | Time to independent productivity | New sales ramp-up shortened from 3 months to 6 weeks |

### 8.2 ROI Example

Assume a 1,000-person knowledge-work enterprise initially covers 300 sales, product, customer success, and project management users. If each person saves 3 hours of transactional work per week, and 50% of that time converts into high-value activities such as customer communication, solution improvement, and product innovation, Relay releases 900 hours per week, with 450 hours redirected into value creation.

| Dimension | Content |
| :-: | :-: |
| Covered Users | 300 |
| Time Saved per User per Week | 3 hours |
| Total Time Released per Week | 900 hours |
| Converted to High-value Work | Approximately 450 hours |
| Additional Gains | More sales opportunities, earlier renewal risk handling, faster product delivery, increased knowledge reuse |

### 8.3 Executive Metrics

- Higher share of user time spent on high-value work.
- Shorter cross-functional collaboration cycles.
- Improved sales conversion, renewal rate, and customer satisfaction.
- Lower knowledge search time and fewer repeated questions.
- Shorter new user ramp-up cycles.
- Higher rate of expert experience converted into assets.

## 9. Business Model and Customer Adoption Path

### 9.1 Business Model

| Model | Description | Suitable Customers |
| :-: | :-: | :-: |
| SaaS Subscription | Charge by user / agent seat, with standard connectors and knowledge capabilities | Small and midsize knowledge-work enterprises |
| Enterprise Subscription | Charge by organization size, connectors, data volume, and governance capabilities | Medium and large enterprises |
| Scenario Packages | Sales Relay, Product Relay, Customer Success Relay, Engineering Relay, and similar packages | Vertical departments seeking fast adoption |
| Private Deployment | Support enterprise intranets, dedicated models, dedicated storage, and audit | Finance, government, and large groups |
| Professional Services | Scenario consulting, connector development, knowledge governance, process redesign | Complex customers |

### 9.2 Initial Customer Entry Strategy

1. Do not enter as an "all-user agent platform"; start with high-ROI scenarios.
2. Prioritize core value-chain departments such as sales, customer success, and product engineering.
3. Use a 6-8 week PoC to prove productivity gains, knowledge reuse, and business metric improvement.
4. Expand from one department to cross-functional scenarios, then to organization-level intelligence.

| |
| :-: |
| Recommended GTM: start with sales / customer success growth scenarios or product and engineering collaboration scenarios. These prove ROI more clearly than a generic AI assistant. |

## 10. Product Roadmap

| Phase | Timeline | Goal | Core Capabilities | Success Criteria |
| :-: | :-: | :-: | :-: | :-: |
| Phase 1: Personal Relay | 0-6 months | Make users willing to use Relay every day | IM access, knowledge retrieval, meeting / document assistant, basic task execution | DAU / WAU, task completion rate, user satisfaction |
| Phase 2: Scenario Relay | 6-12 months | Prove ROI in core business scenarios | Sales, product, and customer success scenario packages; CRM / Jira / document connectors; approval mechanisms | Scenario ROI, customer renewal, department expansion |
| Phase 3: Team Relay | 12-18 months | Upgrade from personal assistant to team collaboration intelligence | Team status, project risks, cross-agent collaboration, management dashboards | Shorter team collaboration cycles, earlier risk discovery |
| Phase 4: Organization Relay | 18-36 months | Build an organizational intelligence network | Organizational memory, expert experience library, capability graph, governance and audit | Knowledge reuse rate, expert capability replication, enterprise-scale deployment |

## 11. Risks, Boundaries, and Governance

| Risk | Manifestation | Governance Strategy |
| :-: | :-: | :-: |
| User Resistance | Users worry about replacement or monitoring | Emphasize user amplification in positioning; provide data transparency and user-controlled authorization |
| Permission Risk | Agent misoperation or unauthorized access | Three-layer permissions: user permission, agent permission, task permission; audit trail |
| Hallucination and Error | Incorrect information or recommendations | Require sources, confidence signals, and human confirmation for critical tasks |
| Data Security | Sensitive data leakage | Tenant isolation, private deployment, masking, access control |
| Tool Execution Risk | External sending, approvals, deletions, and other high-risk actions | Human-in-the-loop and approval policies |
| Invisible Value | Customers cannot see time saved or value created | Built-in ROI dashboard and scenario metrics |

## 12. Conclusion

Relay's opportunity is not to build yet another agent platform. It is to redefine how users and organizations work in the AI era.

The valuable product narrative is not "every user gets a digital worker." It is "every user gets an AI Partner that helps them become more focused, more efficient, and more creative."

Relay should enter through high-value, frequent, measurable business scenarios, first helping sales, product, customer success, engineering, and professional services teams increase value creation. As data, memory, collaboration, and experience capture accumulate, Relay will evolve from an individual productivity tool into enterprise organizational intelligence infrastructure.

| |
| :-: |
| Final Positioning: Relay is an AI Workforce Intelligence Platform that helps enterprises maximize user productivity and value creation. |

Relay Product Plan V1.0 | Confidential
