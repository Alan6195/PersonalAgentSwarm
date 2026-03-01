import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://agent:3001";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { message, item_context } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 }
      );
    }

    if (!WEBHOOK_SECRET) {
      return NextResponse.json(
        { error: "WEBHOOK_SECRET not configured" },
        { status: 500 }
      );
    }

    // Proxy to agent-service dashboard webhook
    const agentResponse = await fetch(
      `${AGENT_SERVICE_URL}/api/webhooks/dashboard`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": WEBHOOK_SECRET,
        },
        body: JSON.stringify({ message, item_context }),
      }
    );

    if (!agentResponse.ok) {
      const errData = await agentResponse.json().catch(() => ({}));
      return NextResponse.json(
        { error: "Agent service error", details: errData },
        { status: agentResponse.status }
      );
    }

    const result = await agentResponse.json();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Travel message error:", error);
    return NextResponse.json(
      { error: "Failed to send message to agent" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    // Get trip
    const [trip] = await query<any>(
      `SELECT id FROM travel_trips WHERE trip_id = 'portugal-honeymoon-2026' LIMIT 1`
    );

    if (!trip) {
      return NextResponse.json({ messages: [] });
    }

    // Fetch recent messages
    let messages: any[] = [];
    try {
      messages = await query<any>(
        `SELECT * FROM dashboard_messages
         WHERE trip_db_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [trip.id]
      );
      messages.reverse();
    } catch {
      messages = [];
    }

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("Travel messages GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 }
    );
  }
}
