/**
 * Content Database Abstraction Layer
 * Supports: Local JSON (Phase 1), WordPress REST API (Phase 2)
 */

const CLEARANCE_HIERARCHY = {
  'INTERNAL': 1,
  'CONFIDENTIAL': 2,
  'RESTRICTED': 3,
  'TOP-SECRET': 4
};

// Local content storage (Phase 1)
const LOCAL_CONTENT = {
  sections: [
    {
      id: 'public-1',
      title: 'Welcome to Secure Information Portal',
      requiredLevel: 0,
      clearanceBadge: 'PUBLIC',
      category: 'general',
      content: `Welcome to the Secure Information Portal.

This section is visible to all visitors.

**What is this portal?**
This is a secure information system that provides access to classified information based on your security clearance level.

**How to get access to restricted content:**
1. Click the "Get Security Clearance" button below
2. Follow the verification process
3. Receive your Security Clearance credential
4. Return to this page to see additional content based on your clearance level

**Available Clearance Levels:**
- INTERNAL: Basic organizational information
- CONFIDENTIAL: Sensitive business information
- RESTRICTED: Highly sensitive strategic information
- TOP-SECRET: Classified information requiring highest clearance`
    },
    {
      id: 'internal-1',
      title: 'Internal Operations Report - Q4 2025',
      requiredLevel: 1,
      clearanceBadge: 'INTERNAL',
      category: 'operations',
      content: `INTERNAL USE ONLY

**Q4 2025 Financial Summary**

Revenue Performance:
- Total Revenue: $12.5M (15% increase YoY)
- Operational Costs: $8.2M
- Net Profit: $4.3M
- EBITDA Margin: 34%

**Department Headcount:**
- Engineering: 45 employees
- Operations: 22 employees
- Sales & Marketing: 18 employees
- Administration: 12 employees

**Key Initiatives:**
- Cloud migration project: 65% complete
- New product development: On track for Q2 2026 launch
- Customer satisfaction: 92% (up from 87%)`
    },
    {
      id: 'internal-2',
      title: 'HR Policy Updates - 2026',
      requiredLevel: 1,
      clearanceBadge: 'INTERNAL',
      category: 'hr',
      content: `INTERNAL USE ONLY

**New Policies Effective Q1 2026**

**Remote Work Policy:**
- Eligibility expanded to all departments
- Hybrid model: 3 days in office, 2 days remote (flexible)
- Equipment stipend: $1,500 per employee

**Benefits Improvements:**
- Additional PTO: +5 days for employees with 5+ years tenure
- Health insurance: Expanded coverage including dental and vision
- Parental leave: 16 weeks paid (up from 12 weeks)
- Professional development: $2,000 annual budget per employee

**Performance Review Process:**
- Moving to continuous feedback model
- Quarterly check-ins replace annual reviews
- New competency framework implemented`
    },
    {
      id: 'confidential-1',
      title: 'Project Phoenix - Development Status',
      requiredLevel: 2,
      clearanceBadge: 'CONFIDENTIAL',
      category: 'projects',
      content: `CONFIDENTIAL - RESTRICTED ACCESS

**Project Phoenix: Next-Generation Platform**

**Current Status:**
- Phase 1: Complete ✓ (Infrastructure setup)
- Phase 2: 85% complete (Core features development)
- Phase 3: Planning stage (Beta testing)

**Budget & Timeline:**
- Total Budget: $2.5M allocated
- Spent to Date: $1.8M (72%)
- Remaining: $700K
- Launch Target: Q2 2026

**Key Milestones:**
- Alpha Testing: January 2026
- Beta Launch: March 2026
- Production Release: June 2026

**Partnership Discussions:**
- TechCorp International: Advanced negotiations ($15M potential contract)
- Global Solutions Inc: Initial discussions ongoing
- Enterprise Systems Ltd: NDA signed, technical evaluation in progress

**Competitive Advantage:**
Our patent-pending technology provides 40% performance improvement over nearest competitor.`
    },
    {
      id: 'confidential-2',
      title: 'Security Incident Report #2025-042',
      requiredLevel: 2,
      clearanceBadge: 'CONFIDENTIAL',
      category: 'security',
      content: `CONFIDENTIAL - SECURITY INCIDENT REPORT

**Incident ID:** 2025-042
**Date Detected:** October 28, 2025, 14:23 UTC
**Severity:** Medium
**Status:** RESOLVED

**Summary:**
Automated security systems detected unauthorized access attempts targeting internal network infrastructure.

**Technical Details:**
- Attack Vector: Port scanning from IP range 198.51.100.0/24
- Systems Targeted: VPN gateway, internal API endpoints
- Attempts Blocked: 147 connection attempts over 6-hour period
- Firewall Rules: Automatically updated to blacklist source IPs

**Response Actions:**
1. Immediate IP range blacklist applied
2. Full security audit completed (no vulnerabilities found)
3. All access logs reviewed and archived
4. Incident response team activated
5. Law enforcement notified

**Impact Assessment:**
- No data breach confirmed
- No system compromise detected
- All authentication systems functioning normally
- Zero downtime for services

**Lessons Learned:**
- Automated threat detection performed as expected
- Response time: 8 minutes from detection to mitigation
- Recommendation: Implement additional rate limiting on public endpoints`
    },
    {
      id: 'restricted-1',
      title: 'Enterprise Client Acquisition Strategy',
      requiredLevel: 3,
      clearanceBadge: 'RESTRICTED',
      category: 'business',
      content: `RESTRICTED - BUSINESS SENSITIVE

**Q1 2026 Enterprise Client Acquisition Strategy**

**Target Companies (Priority Order):**

1. **TechCorp International**
   - Potential Contract Value: $50M over 3 years
   - Decision Timeline: Q1 2026
   - Key Decision Maker: Sarah Chen (CTO)
   - Status: Advanced negotiations, technical POC approved
   - Our Advantage: 40% cost savings vs current solution

2. **Global Finance Group**
   - Potential Contract Value: $35M over 3 years
   - Decision Timeline: Q2 2026
   - Key Decision Maker: Michael Rodriguez (VP Technology)
   - Status: Initial proposal submitted
   - Our Advantage: Compliance features (GDPR, SOC2, HIPAA)

3. **Healthcare Systems Inc**
   - Potential Contract Value: $28M over 3 years
   - Decision Timeline: Q3 2026
   - Key Decision Maker: Dr. Jennifer Liu (Chief Medical Information Officer)
   - Status: Discovery phase
   - Our Advantage: Healthcare-specific integrations

**Sales Approach:**
- Custom POC development (8-week timeline per prospect)
- Executive-level presentations with board members
- Strategic partnership model (not just vendor relationship)
- Risk-sharing pricing model to accelerate adoption

**Competitive Intelligence:**
- Competitor A: Pricing 60% higher, outdated technology
- Competitor B: Recent security breach affecting reputation
- Competitor C: Limited healthcare compliance features

**Pricing Strategy:**
- Year 1: Discounted rate to secure adoption ($0.85 per unit)
- Years 2-3: Standard rate ($1.20 per unit)
- Volume discounts: 15% for >100K units, 25% for >500K units`
    },
    {
      id: 'topsecret-1',
      title: 'Strategic Intelligence Brief - Market Position',
      requiredLevel: 4,
      clearanceBadge: 'TOP-SECRET',
      category: 'strategic',
      content: `TOP-SECRET - EXECUTIVE LEVEL ONLY
UNAUTHORIZED DISCLOSURE PROHIBITED

**Strategic Market Intelligence Summary**

**Competitive Landscape Analysis:**

**Competitor A (Market Leader - 35% share):**
- Intelligence Source: Industry contacts, public filings
- Planning major acquisition of SmallTech Inc (estimated $500M)
- Expected completion: Q2 2026
- Our Assessment: Will strengthen their position but create integration challenges
- Our Response: Accelerate Project Phoenix to capture market during their transition

**Competitor B (Second Position - 28% share):**
- Intelligence Source: Former employees (legal recruitment)
- Facing significant financial difficulties
- Confirmed: 15% workforce reduction planned for January 2026
- Debt restructuring in progress ($200M in obligations)
- Our Assessment: Vulnerable to acquisition or market exit
- Our Opportunity: Target their key clients during instability period

**Market Consolidation Forecast:**
- Industry analysts predict 40% consolidation within 18 months
- 12 current players expected to reduce to 6-7 major providers
- Our position: Strong candidate for acquisition OR acquirer

**Strategic Positioning:**

**Intellectual Property:**
- Patent Filing #2025-7821: APPROVED (Nov 2025)
- Technology provides 40% performance improvement
- Estimated competitive advantage: 24-30 months before competitors catch up
- Licensing opportunity: Potential $50M revenue stream

**Board-Approved Initiatives:**

1. **Expansion Budget: $100M approved**
   - Geographic expansion: EU market entry (Q2 2026)
   - Product line expansion: Enterprise+ tier launch
   - Strategic hiring: 50 senior engineers

2. **M&A Strategy:**
   - Target A: DataTech Solutions ($45M valuation)
     - Rationale: Complementary technology, expand customer base
     - Due diligence: 60% complete
     - Board approval: Pending final valuation

   - Target B: CloudSystems Inc ($32M valuation)
     - Rationale: Geographic presence (EU), established client base
     - Status: Initial discussions, NDA signed
     - Timeline: Q2 2026 potential close

**Confidential Financial Projections:**
- 2026 Revenue Target: $85M (68% growth)
- 2027 Revenue Target: $140M (65% growth)
- Path to IPO: 2028 (target valuation $800M-1.2B)

**Critical Success Factors:**
1. Project Phoenix successful launch (June 2026)
2. TechCorp International contract secured ($50M)
3. Patent portfolio expansion (3 additional filings in progress)
4. Zero major security incidents
5. Key talent retention (executive team fully vested)

**Risk Factors:**
- Regulatory changes (data privacy legislation pending)
- Competitive response to patent (legal challenges possible)
- Economic downturn affecting enterprise spending
- Cybersecurity threat landscape

---

**Distribution:** CEO, CTO, CFO, Board of Directors
**Classification:** TOP-SECRET
**Review Date:** Quarterly
**Document Control:** #TS-2025-STRAT-001`
    }
  ]
};

class ContentDatabase {
  constructor() {
    // Environment-based configuration
    this.contentSource = process.env.CONTENT_SOURCE || 'local';
    this.wordPressURL = process.env.WORDPRESS_URL || null;
    this.useWordPress = this.contentSource === 'wordpress' && this.wordPressURL;

    console.log(`[ContentDatabase] Initialized with source: ${this.contentSource}`);
  }

  /**
   * Get accessible content based on user's clearance level
   * @param {string|null} clearanceLevel - User's clearance level (null for public only)
   * @returns {Promise<Array>} Array of content sections
   */
  async getAccessibleContent(clearanceLevel = null) {
    if (this.useWordPress) {
      return this.getContentFromWordPress(clearanceLevel);
    } else {
      return this.getContentFromLocal(clearanceLevel);
    }
  }

  /**
   * Get content from local JSON storage (Phase 1)
   */
  getContentFromLocal(clearanceLevel) {
    const userLevel = clearanceLevel ? (CLEARANCE_HIERARCHY[clearanceLevel] || 0) : 0;

    const accessibleSections = LOCAL_CONTENT.sections.filter(
      section => section.requiredLevel <= userLevel
    );

    console.log(`[ContentDatabase] Local: Returning ${accessibleSections.length} sections for level ${clearanceLevel || 'PUBLIC'}`);

    return accessibleSections;
  }

  /**
   * Get content from WordPress REST API (Phase 2 - Future)
   */
  async getContentFromWordPress(clearanceLevel) {
    // TODO: Implement in Phase 2
    console.log('[ContentDatabase] WordPress integration not yet implemented, falling back to local');
    return this.getContentFromLocal(clearanceLevel);
  }

  /**
   * Get clearance badge color
   */
  getClearanceBadgeColor(badge) {
    const colors = {
      'PUBLIC': '#4CAF50',
      'INTERNAL': '#2196F3',
      'CONFIDENTIAL': '#FF9800',
      'RESTRICTED': '#9C27B0',
      'TOP-SECRET': '#F44336'
    };
    return colors[badge] || '#9E9E9E';
  }
}

module.exports = new ContentDatabase();
