# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Travel planning skill — weather forecasts, place search, directions, flights, and itinerary management.

Provides five tools for AI-assisted travel planning:
- travel_get_weather: Weather forecasts via Open-Meteo (free, no key required)
- travel_search_places: Place search via Google Maps Places API (optional key)
- travel_get_directions: Directions via Google Maps Directions API (optional key)
- travel_search_flights: Flight search via Google Flights (fast-flights, no key required)
- travel_manage_itinerary: In-memory per-session itinerary CRUD
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# WMO Weather interpretation codes → human-readable descriptions
# https://open-meteo.com/en/docs#weathervariables
# ---------------------------------------------------------------------------

WMO_CODES: Dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
}

# ---------------------------------------------------------------------------
# Google Places price level → display string
# ---------------------------------------------------------------------------

PRICE_LEVEL_MAP: Dict[str, str] = {
    "PRICE_LEVEL_FREE": "Free",
    "PRICE_LEVEL_INEXPENSIVE": "$",
    "PRICE_LEVEL_MODERATE": "$$",
    "PRICE_LEVEL_EXPENSIVE": "$$$",
    "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$",
}

# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function calling format)
# ---------------------------------------------------------------------------

TRAVEL_GET_WEATHER_SCHEMA = {
    "type": "function",
    "display_name": "Weather",
    "function": {
        "name": "travel_get_weather",
        "description": (
            "Get weather forecast for a location. Returns daily forecasts "
            "including temperature, precipitation, wind, and conditions. "
            "Uses Open-Meteo API (free, no API key required). "
            "Supports up to 16 days of forecast data."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City or place name (e.g. 'Seoul', 'Paris, France', 'Tokyo')",
                },
                "forecast_days": {
                    "type": "integer",
                    "description": "Number of forecast days (1-16, default: 7)",
                },
            },
            "required": ["location"],
        },
    },
}

TRAVEL_SEARCH_PLACES_SCHEMA = {
    "type": "function",
    "display_name": "Places",
    "function": {
        "name": "travel_search_places",
        "description": (
            "Search for places, attractions, restaurants, or hotels near a location. "
            "Uses Google Maps Places API when GOOGLE_MAPS_API_KEY is configured. "
            "Returns name, address, rating, reviews (up to 3 per place with author, "
            "rating, text, time), price_level ($~$$$$), opening_hours, website, "
            "editorial_summary, coordinates (lat/lon), and Google Maps link for each result. "
            "Use reviews to summarize highlights and characteristics of each place."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (e.g. 'best restaurants in Seoul', 'hotels near Eiffel Tower')",
                },
                "location": {
                    "type": "string",
                    "description": "Optional location bias (e.g. 'Seoul, Korea'). Improves relevance of results.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (1-10, default: 5)",
                },
            },
            "required": ["query"],
        },
    },
}

TRAVEL_GET_DIRECTIONS_SCHEMA = {
    "type": "function",
    "display_name": "Directions",
    "function": {
        "name": "travel_get_directions",
        "description": (
            "Get directions between two locations including distance, duration, "
            "step-by-step instructions, and a Google Maps link. "
            "For transit mode, includes line names, vehicle types, and stop details. "
            "Uses Google Maps Directions API when GOOGLE_MAPS_API_KEY is configured."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "origin": {
                    "type": "string",
                    "description": "Starting point (e.g. 'Seoul Station', 'Eiffel Tower, Paris')",
                },
                "destination": {
                    "type": "string",
                    "description": "Destination (e.g. 'Gyeongbokgung Palace', 'Louvre Museum, Paris')",
                },
                "mode": {
                    "type": "string",
                    "enum": ["driving", "walking", "transit", "bicycling"],
                    "description": "Travel mode (default: 'transit')",
                },
            },
            "required": ["origin", "destination"],
        },
    },
}

TRAVEL_MANAGE_ITINERARY_SCHEMA = {
    "type": "function",
    "display_name": "Itinerary",
    "function": {
        "name": "travel_manage_itinerary",
        "description": (
            "Create and manage a travel itinerary. Supports creating itineraries, "
            "adding/updating/removing activities, and viewing the full plan. "
            "Itinerary state is maintained per session."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "add_activity", "update_activity", "remove_activity", "view"],
                    "description": "Action to perform on the itinerary",
                },
                "title": {
                    "type": "string",
                    "description": "Itinerary title (required for 'create')",
                },
                "destination": {
                    "type": "string",
                    "description": "Travel destination (required for 'create')",
                },
                "start_date": {
                    "type": "string",
                    "description": "Trip start date in YYYY-MM-DD format (required for 'create')",
                },
                "end_date": {
                    "type": "string",
                    "description": "Trip end date in YYYY-MM-DD format (required for 'create')",
                },
                "day": {
                    "type": "integer",
                    "description": "Day number (1-based) for activity operations",
                },
                "activity_id": {
                    "type": "string",
                    "description": "Activity ID for update/remove (e.g. 'a1', 'a2')",
                },
                "time": {
                    "type": "string",
                    "description": "Activity time (e.g. '09:00', '14:30')",
                },
                "activity_name": {
                    "type": "string",
                    "description": "Activity name or title",
                },
                "location": {
                    "type": "string",
                    "description": "Activity location or venue",
                },
                "notes": {
                    "type": "string",
                    "description": "Additional notes for the activity",
                },
                "url": {
                    "type": "string",
                    "description": "External URL for the activity (website, booking link, etc.)",
                },
                "maps_url": {
                    "type": "string",
                    "description": "Google Maps URL for the activity location",
                },
                "duration": {
                    "type": "string",
                    "description": "Estimated duration (e.g. '1.5hr', '45min')",
                },
                "category": {
                    "type": "string",
                    "enum": ["food", "sightseeing", "transport", "shopping", "rest", "accommodation"],
                    "description": "Activity category for budget tracking and itinerary formatting",
                },
                "estimated_cost": {
                    "type": "string",
                    "description": "Estimated cost per person (e.g. '~¥1,500', 'free', '~$25')",
                },
                "rating": {
                    "type": "number",
                    "description": "Place rating (e.g. 4.5)",
                },
                "price_level": {
                    "type": "string",
                    "description": "Price level from Places API (e.g. '$', '$$', '$$$')",
                },
                "opening_hours": {
                    "type": "string",
                    "description": "Opening hours (e.g. '09:00-17:00', 'Mon-Sat 10:00-20:00')",
                },
                "website": {
                    "type": "string",
                    "description": "Official website URL of the place",
                },
                "lat": {
                    "type": "number",
                    "description": "Latitude from travel_search_places result (for map display)",
                },
                "lon": {
                    "type": "number",
                    "description": "Longitude from travel_search_places result (for map display)",
                },
                "review_summary": {
                    "type": "string",
                    "description": "Synthesized review highlights (e.g. 'Rich tonkotsu broth, 30min wait at lunch, friendly staff')",
                },
            },
            "required": ["action"],
        },
    },
}

TRAVEL_SEARCH_FLIGHTS_SCHEMA = {
    "type": "function",
    "display_name": "Flights",
    "function": {
        "name": "travel_search_flights",
        "description": (
            "Search for flights between airports using Google Flights. "
            "Returns airline, times, duration, stops, and price. "
            "No API key required."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "origin": {
                    "type": "string",
                    "description": "Departure airport IATA code (e.g. 'ICN', 'NRT', 'LAX')",
                },
                "destination": {
                    "type": "string",
                    "description": "Arrival airport IATA code (e.g. 'KIX', 'CDG', 'JFK')",
                },
                "date": {
                    "type": "string",
                    "description": "Departure date in YYYY-MM-DD format",
                },
                "return_date": {
                    "type": "string",
                    "description": "Return date in YYYY-MM-DD (for round-trip). Omit for one-way.",
                },
                "seat": {
                    "type": "string",
                    "enum": ["economy", "premium-economy", "business", "first"],
                    "description": "Cabin class (default: economy)",
                },
                "passengers": {
                    "type": "integer",
                    "description": "Number of adult passengers (default: 1, max: 9)",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Max flights to return (default: 5, max: 20)",
                },
            },
            "required": ["origin", "destination", "date"],
        },
    },
}

# ---------------------------------------------------------------------------
# Itinerary data model
# ---------------------------------------------------------------------------


@dataclass
class Activity:
    id: str
    time: str
    name: str
    location: str = ""
    notes: str = ""
    url: str = ""
    maps_url: str = ""
    duration: str = ""
    lat: float = 0.0
    lon: float = 0.0
    category: str = ""  # "food", "sightseeing", "transport", "shopping", "rest", "accommodation"
    estimated_cost: str = ""  # "~¥1,500", "free"
    rating: float = 0.0
    price_level: str = ""  # "$", "$$", "$$$"
    opening_hours: str = ""  # "09:00-17:00"
    website: str = ""
    review_summary: str = ""  # synthesized review highlights


@dataclass
class DayPlan:
    day_number: int
    date: str
    activities: List[Activity] = field(default_factory=list)


@dataclass
class Itinerary:
    title: str
    destination: str
    start_date: str
    end_date: str
    days: Dict[int, DayPlan] = field(default_factory=dict)
    _next_activity_id: int = field(default=1, repr=False)

    def next_id(self) -> str:
        aid = f"a{self._next_activity_id}"
        self._next_activity_id += 1
        return aid


# ---------------------------------------------------------------------------
# TravelSkill
# ---------------------------------------------------------------------------


class TravelSkill:
    """Travel planning skill with weather, places, directions, and itinerary tools."""

    name = "travel_task"
    tool_schemas = [
        TRAVEL_GET_WEATHER_SCHEMA,
        TRAVEL_SEARCH_PLACES_SCHEMA,
        TRAVEL_GET_DIRECTIONS_SCHEMA,
        TRAVEL_SEARCH_FLIGHTS_SCHEMA,
        TRAVEL_MANAGE_ITINERARY_SCHEMA,
    ]

    def __init__(self) -> None:
        self._itineraries: Dict[str, Itinerary] = {}  # session_id → Itinerary

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    async def execute(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        handlers = {
            "travel_get_weather": self._handle_weather,
            "travel_search_places": self._handle_places,
            "travel_get_directions": self._handle_directions,
            "travel_search_flights": self._handle_flights,
            "travel_manage_itinerary": self._handle_itinerary,
        }
        handler = handlers.get(name)
        if not handler:
            return f"Error: unknown tool '{name}'"

        try:
            return await handler(arguments, session_id)
        except Exception as e:
            logger.exception("travel_task execute error: tool=%s", name)
            return f"Error executing {name}: {e}"

    # ------------------------------------------------------------------
    # Weather (Open-Meteo — free, no key required)
    # ------------------------------------------------------------------

    async def _handle_weather(self, args: Dict[str, Any], session_id: str) -> str:
        location = args.get("location", "").strip()
        if not location:
            return "Error: 'location' is required"

        forecast_days = min(max(args.get("forecast_days", 7), 1), 16)

        async with httpx.AsyncClient(timeout=15.0) as client:
            # Step 1: Geocode location name → coordinates
            geo_resp = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": location, "count": 1, "language": "en"},
            )
            geo_resp.raise_for_status()
            geo_data = geo_resp.json()

            results = geo_data.get("results")
            if not results:
                return f"Could not find location: '{location}'. Try a more specific city name."

            place = results[0]
            lat = place["latitude"]
            lon = place["longitude"]
            resolved_name = place.get("name", location)
            country = place.get("country", "")

            # Step 2: Fetch weather forecast
            weather_resp = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
                    "timezone": "auto",
                    "forecast_days": forecast_days,
                },
            )
            weather_resp.raise_for_status()
            weather_data = weather_resp.json()

        daily = weather_data.get("daily", {})
        dates = daily.get("time", [])
        codes = daily.get("weather_code", [])
        temp_max = daily.get("temperature_2m_max", [])
        temp_min = daily.get("temperature_2m_min", [])
        precip = daily.get("precipitation_sum", [])
        wind = daily.get("wind_speed_10m_max", [])

        forecasts = []
        for i, d in enumerate(dates):
            forecasts.append({
                "date": d,
                "condition": WMO_CODES.get(codes[i] if i < len(codes) else -1, "Unknown"),
                "temp_max_c": temp_max[i] if i < len(temp_max) else None,
                "temp_min_c": temp_min[i] if i < len(temp_min) else None,
                "precipitation_mm": precip[i] if i < len(precip) else None,
                "wind_max_kmh": wind[i] if i < len(wind) else None,
            })

        result = {
            "location": resolved_name,
            "country": country,
            "coordinates": {"lat": lat, "lon": lon},
            "forecast": forecasts,
        }
        return json.dumps(result, ensure_ascii=False)

    # ------------------------------------------------------------------
    # Places (Google Maps Places API — optional)
    # ------------------------------------------------------------------

    async def _handle_places(self, args: Dict[str, Any], session_id: str) -> str:
        query = args.get("query", "").strip()
        if not query:
            return "Error: 'query' is required"

        api_key = settings.GOOGLE_MAPS_API_KEY
        if not api_key:
            return (
                "Google Maps API key is not configured. "
                "To search for places, use the `mcp_web__search` tool instead "
                "with a query like: 'best restaurants in [destination]'. "
                f"Suggested search query: '{query}'"
            )

        location_bias = args.get("location", "")
        max_results = min(max(args.get("max_results", 5), 1), 10)

        params: Dict[str, Any] = {
            "textQuery": query,
            "languageCode": "en",
        }
        if location_bias:
            params["textQuery"] = f"{query} near {location_bias}"

        headers = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": (
                "places.displayName,places.formattedAddress,"
                "places.rating,places.userRatingCount,"
                "places.types,places.googleMapsUri,"
                "places.location,places.reviews,"
                "places.priceLevel,places.regularOpeningHours,"
                "places.websiteUri,places.editorialSummary"
            ),
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://places.googleapis.com/v1/places:searchText",
                json=params,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        places_raw = data.get("places", [])[:max_results]
        places = []
        for p in places_raw:
            display_name = p.get("displayName", {})
            location = p.get("location", {})

            reviews_raw = p.get("reviews", [])[:3]
            reviews = []
            for r in reviews_raw:
                reviews.append({
                    "author": r.get("authorAttribution", {}).get("displayName", ""),
                    "rating": r.get("rating"),
                    "text": (r.get("text") or r.get("originalText") or {}).get("text", ""),
                    "time": r.get("relativePublishTimeDescription", ""),
                })

            # Map price level
            raw_price = p.get("priceLevel", "")
            price_level = PRICE_LEVEL_MAP.get(raw_price, "")

            # Opening hours
            opening_hours_obj = p.get("regularOpeningHours", {})
            opening_hours = opening_hours_obj.get("weekdayDescriptions", [])

            # Editorial summary
            editorial_obj = p.get("editorialSummary", {})
            editorial_summary = editorial_obj.get("text", "")

            places.append({
                "name": display_name.get("text", "Unknown"),
                "address": p.get("formattedAddress", ""),
                "rating": p.get("rating"),
                "review_count": p.get("userRatingCount"),
                "types": p.get("types", [])[:3],
                "maps_url": p.get("googleMapsUri", ""),
                "lat": location.get("latitude"),
                "lon": location.get("longitude"),
                "reviews": reviews,
                "price_level": price_level,
                "opening_hours": opening_hours,
                "website": p.get("websiteUri", ""),
                "editorial_summary": editorial_summary,
            })

        return json.dumps({"query": query, "results": places}, ensure_ascii=False)

    # ------------------------------------------------------------------
    # Directions (Google Maps Directions API — optional)
    # ------------------------------------------------------------------

    async def _handle_directions(self, args: Dict[str, Any], session_id: str) -> str:
        origin = args.get("origin", "").strip()
        destination = args.get("destination", "").strip()
        if not origin or not destination:
            return "Error: both 'origin' and 'destination' are required"

        api_key = settings.GOOGLE_MAPS_API_KEY
        if not api_key:
            return (
                "Google Maps API key is not configured. "
                "To get directions, use the `mcp_web__search` tool with a query like: "
                f"'directions from {origin} to {destination}'. "
                "Or use a maps application for detailed route information."
            )

        mode = args.get("mode", "transit")

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://maps.googleapis.com/maps/api/directions/json",
                params={
                    "origin": origin,
                    "destination": destination,
                    "mode": mode,
                    "key": api_key,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("status") != "OK":
            return f"Directions not found: {data.get('status')}. Try different location names."

        routes = data.get("routes", [])
        if not routes:
            return "No routes found between the specified locations."

        route = routes[0]
        legs = route.get("legs", [])
        if not legs:
            return "No route details available."

        leg = legs[0]
        steps = []
        for s in leg.get("steps", [])[:15]:  # Limit to 15 steps
            instruction = s.get("html_instructions", "")
            instruction = re.sub(r"<[^>]+>", " ", instruction).strip()
            instruction = re.sub(r"  +", " ", instruction)

            step_data: Dict[str, Any] = {
                "instruction": instruction,
                "distance": s.get("distance", {}).get("text", ""),
                "duration": s.get("duration", {}).get("text", ""),
                "travel_mode": s.get("travel_mode", ""),
            }

            # Enrich transit steps with line/stop details
            transit = s.get("transit_details")
            if transit:
                line = transit.get("line", {})
                vehicle = line.get("vehicle", {})
                step_data["transit"] = {
                    "line_name": line.get("name", ""),
                    "short_name": line.get("short_name", ""),
                    "vehicle_type": vehicle.get("type", ""),
                    "departure_stop": transit.get("departure_stop", {}).get("name", ""),
                    "arrival_stop": transit.get("arrival_stop", {}).get("name", ""),
                    "num_stops": transit.get("num_stops"),
                    "headsign": transit.get("headsign", ""),
                }

            steps.append(step_data)

        # Build a Google Maps directions URL
        maps_url = (
            f"https://www.google.com/maps/dir/?api=1"
            f"&origin={quote(leg.get('start_address', origin))}"
            f"&destination={quote(leg.get('end_address', destination))}"
            f"&travelmode={mode}"
        )

        result = {
            "origin": leg.get("start_address", origin),
            "destination": leg.get("end_address", destination),
            "distance": leg.get("distance", {}).get("text", ""),
            "duration": leg.get("duration", {}).get("text", ""),
            "mode": mode,
            "maps_url": maps_url,
            "steps": steps,
        }
        return json.dumps(result, ensure_ascii=False)

    # ------------------------------------------------------------------
    # Flights (Google Flights via fast-flights — free, no key required)
    # ------------------------------------------------------------------

    async def _handle_flights(self, args: Dict[str, Any], session_id: str) -> str:
        origin = args.get("origin", "").strip().upper()
        destination = args.get("destination", "").strip().upper()
        dep_date = args.get("date", "").strip()

        if not origin or not destination or not dep_date:
            return "Error: 'origin', 'destination', and 'date' are required"

        if len(origin) != 3 or len(destination) != 3:
            return "Error: origin and destination must be 3-letter IATA airport codes (e.g. 'ICN', 'KIX')"

        try:
            date.fromisoformat(dep_date)
        except ValueError:
            return "Error: 'date' must be in YYYY-MM-DD format"

        return_date = args.get("return_date", "").strip() or None
        if return_date:
            try:
                date.fromisoformat(return_date)
            except ValueError:
                return "Error: 'return_date' must be in YYYY-MM-DD format"

        seat = args.get("seat", "economy")
        passengers = min(max(args.get("passengers", 1), 1), 9)
        max_results = min(max(args.get("max_results", 5), 1), 20)

        try:
            from fast_flights import FlightData, Passengers, get_flights
        except ImportError:
            return "Error: fast-flights library is not installed. Run: pip install fast-flights"

        # Build FlightData list
        flight_data_list = [
            FlightData(
                date=dep_date,
                from_airport=origin,
                to_airport=destination,
            )
        ]
        if return_date:
            flight_data_list.append(
                FlightData(
                    date=return_date,
                    from_airport=destination,
                    to_airport=origin,
                )
            )

        trip = "round-trip" if return_date else "one-way"
        pax = Passengers(adults=passengers)

        # get_flights is synchronous — run in thread to avoid blocking
        result = await asyncio.to_thread(
            get_flights,
            flight_data=flight_data_list,
            trip=trip,
            passengers=pax,
            seat=seat,
            fetch_mode="fallback",
        )

        # Convert result to JSON-serializable format
        flights = []
        for flight in result.flights[:max_results]:
            flight_info: Dict[str, Any] = {
                "airline": getattr(flight, "name", ""),
            }

            departure = getattr(flight, "departure", None)
            arrival = getattr(flight, "arrival", None)
            if departure:
                flight_info["departure"] = str(departure)
            if arrival:
                flight_info["arrival"] = str(arrival)

            duration = getattr(flight, "duration", None)
            if duration:
                flight_info["duration"] = str(duration)

            stops = getattr(flight, "stops", None)
            if stops is not None:
                flight_info["stops"] = stops

            price = getattr(flight, "price", None)
            if price:
                flight_info["price"] = str(price)

            is_best = getattr(flight, "is_best", None)
            if is_best:
                flight_info["is_best"] = True

            flights.append(flight_info)

        output: Dict[str, Any] = {
            "route": f"{origin} → {destination}",
            "date": dep_date,
            "seat": seat,
            "passengers": passengers,
            "flights": flights,
            "total_found": len(result.flights),
            "showing": len(flights),
        }
        if return_date:
            output["return_date"] = return_date
            output["trip_type"] = "round-trip"
        else:
            output["trip_type"] = "one-way"

        current_price = getattr(result, "current_price", None)
        if current_price:
            output["current_price"] = str(current_price)

        return json.dumps(output, ensure_ascii=False)

    # ------------------------------------------------------------------
    # Itinerary management (in-memory, per-session)
    # ------------------------------------------------------------------

    async def _handle_itinerary(self, args: Dict[str, Any], session_id: str) -> str:
        action = args.get("action", "")
        if not action:
            return "Error: 'action' is required"

        if action == "create":
            return self._itinerary_create(args, session_id)
        elif action == "add_activity":
            return self._itinerary_add_activity(args, session_id)
        elif action == "update_activity":
            return self._itinerary_update_activity(args, session_id)
        elif action == "remove_activity":
            return self._itinerary_remove_activity(args, session_id)
        elif action == "view":
            return self._itinerary_view(session_id)
        else:
            return f"Error: unknown action '{action}'. Valid: create, add_activity, update_activity, remove_activity, view"

    def _itinerary_create(self, args: Dict[str, Any], session_id: str) -> str:
        title = args.get("title", "").strip()
        destination = args.get("destination", "").strip()
        start_str = args.get("start_date", "").strip()
        end_str = args.get("end_date", "").strip()

        if not all([title, destination, start_str, end_str]):
            return "Error: 'title', 'destination', 'start_date', and 'end_date' are required for 'create'"

        try:
            start = date.fromisoformat(start_str)
            end = date.fromisoformat(end_str)
        except ValueError:
            return "Error: dates must be in YYYY-MM-DD format"

        if end < start:
            return "Error: end_date must be on or after start_date"

        num_days = (end - start).days + 1
        if num_days > 30:
            return "Error: itinerary cannot exceed 30 days"

        itinerary = Itinerary(
            title=title,
            destination=destination,
            start_date=start_str,
            end_date=end_str,
        )

        for i in range(num_days):
            day_num = i + 1
            day_date = start.isoformat() if i == 0 else date.fromordinal(start.toordinal() + i).isoformat()
            itinerary.days[day_num] = DayPlan(day_number=day_num, date=day_date)

        self._itineraries[session_id] = itinerary

        return json.dumps({
            "status": "created",
            "title": title,
            "destination": destination,
            "dates": f"{start_str} to {end_str}",
            "total_days": num_days,
        }, ensure_ascii=False)

    def _itinerary_add_activity(self, args: Dict[str, Any], session_id: str) -> str:
        itinerary = self._itineraries.get(session_id)
        if not itinerary:
            return "Error: no itinerary exists. Create one first with action='create'."

        day = args.get("day")
        if day is None:
            return "Error: 'day' is required for 'add_activity'"
        if day not in itinerary.days:
            return f"Error: day {day} does not exist. Valid days: 1-{len(itinerary.days)}"

        activity_name = args.get("activity_name", "").strip()
        time_str = args.get("time", "").strip()
        if not activity_name:
            return "Error: 'activity_name' is required for 'add_activity'"

        activity = Activity(
            id=itinerary.next_id(),
            time=time_str or "TBD",
            name=activity_name,
            location=args.get("location", "").strip(),
            notes=args.get("notes", "").strip(),
            url=args.get("url", "").strip(),
            maps_url=args.get("maps_url", "").strip(),
            duration=args.get("duration", "").strip(),
            lat=float(args.get("lat", 0.0) or 0.0),
            lon=float(args.get("lon", 0.0) or 0.0),
            category=args.get("category", "").strip(),
            estimated_cost=args.get("estimated_cost", "").strip(),
            rating=float(args.get("rating", 0.0) or 0.0),
            price_level=args.get("price_level", "").strip(),
            opening_hours=args.get("opening_hours", "").strip(),
            website=args.get("website", "").strip(),
            review_summary=args.get("review_summary", "").strip(),
        )
        itinerary.days[day].activities.append(activity)

        resp: Dict[str, Any] = {
            "status": "added",
            "day": day,
            "activity": {
                "id": activity.id,
                "time": activity.time,
                "name": activity.name,
                "location": activity.location,
                "duration": activity.duration,
                "url": activity.url,
                "maps_url": activity.maps_url,
            },
        }
        if activity.category:
            resp["activity"]["category"] = activity.category
        if activity.estimated_cost:
            resp["activity"]["estimated_cost"] = activity.estimated_cost
        if activity.rating:
            resp["activity"]["rating"] = activity.rating
        if activity.price_level:
            resp["activity"]["price_level"] = activity.price_level
        if activity.opening_hours:
            resp["activity"]["opening_hours"] = activity.opening_hours
        if activity.website:
            resp["activity"]["website"] = activity.website
        if activity.lat:
            resp["activity"]["lat"] = activity.lat
        if activity.lon:
            resp["activity"]["lon"] = activity.lon
        if activity.review_summary:
            resp["activity"]["review_summary"] = activity.review_summary
        return json.dumps(resp, ensure_ascii=False)

    def _itinerary_update_activity(self, args: Dict[str, Any], session_id: str) -> str:
        itinerary = self._itineraries.get(session_id)
        if not itinerary:
            return "Error: no itinerary exists."

        activity_id = args.get("activity_id", "").strip()
        if not activity_id:
            return "Error: 'activity_id' is required for 'update_activity'"

        for day_plan in itinerary.days.values():
            for act in day_plan.activities:
                if act.id == activity_id:
                    if "time" in args:
                        act.time = args["time"].strip()
                    if "activity_name" in args:
                        act.name = args["activity_name"].strip()
                    if "location" in args:
                        act.location = args["location"].strip()
                    if "notes" in args:
                        act.notes = args["notes"].strip()
                    if "url" in args:
                        act.url = args["url"].strip()
                    if "maps_url" in args:
                        act.maps_url = args["maps_url"].strip()
                    if "duration" in args:
                        act.duration = args["duration"].strip()
                    if "category" in args:
                        act.category = args["category"].strip()
                    if "estimated_cost" in args:
                        act.estimated_cost = args["estimated_cost"].strip()
                    if "rating" in args:
                        act.rating = float(args["rating"] or 0.0)
                    if "price_level" in args:
                        act.price_level = args["price_level"].strip()
                    if "opening_hours" in args:
                        act.opening_hours = args["opening_hours"].strip()
                    if "website" in args:
                        act.website = args["website"].strip()
                    if "lat" in args:
                        act.lat = float(args["lat"] or 0.0)
                    if "lon" in args:
                        act.lon = float(args["lon"] or 0.0)
                    if "review_summary" in args:
                        act.review_summary = args["review_summary"].strip()
                    resp: Dict[str, Any] = {
                        "status": "updated",
                        "activity": {
                            "id": act.id,
                            "time": act.time,
                            "name": act.name,
                            "location": act.location,
                            "notes": act.notes,
                            "duration": act.duration,
                            "url": act.url,
                            "maps_url": act.maps_url,
                        },
                    }
                    if act.category:
                        resp["activity"]["category"] = act.category
                    if act.estimated_cost:
                        resp["activity"]["estimated_cost"] = act.estimated_cost
                    if act.rating:
                        resp["activity"]["rating"] = act.rating
                    if act.price_level:
                        resp["activity"]["price_level"] = act.price_level
                    if act.opening_hours:
                        resp["activity"]["opening_hours"] = act.opening_hours
                    if act.website:
                        resp["activity"]["website"] = act.website
                    if act.lat:
                        resp["activity"]["lat"] = act.lat
                    if act.lon:
                        resp["activity"]["lon"] = act.lon
                    if act.review_summary:
                        resp["activity"]["review_summary"] = act.review_summary
                    return json.dumps(resp, ensure_ascii=False)

        return f"Error: activity '{activity_id}' not found"

    def _itinerary_remove_activity(self, args: Dict[str, Any], session_id: str) -> str:
        itinerary = self._itineraries.get(session_id)
        if not itinerary:
            return "Error: no itinerary exists."

        activity_id = args.get("activity_id", "").strip()
        if not activity_id:
            return "Error: 'activity_id' is required for 'remove_activity'"

        for day_plan in itinerary.days.values():
            for i, act in enumerate(day_plan.activities):
                if act.id == activity_id:
                    removed = day_plan.activities.pop(i)
                    return json.dumps({
                        "status": "removed",
                        "activity_id": removed.id,
                        "activity_name": removed.name,
                    }, ensure_ascii=False)

        return f"Error: activity '{activity_id}' not found"

    def _itinerary_view(self, session_id: str) -> str:
        itinerary = self._itineraries.get(session_id)
        if not itinerary:
            return "No itinerary exists for this session. Create one first."

        return json.dumps(self._render_itinerary(itinerary), ensure_ascii=False)

    # ------------------------------------------------------------------
    # State prompt (injected every LLM turn)
    # ------------------------------------------------------------------

    def get_state_prompt(self, session_id: str) -> Optional[str]:
        itinerary = self._itineraries.get(session_id)
        if not itinerary:
            return None

        category_emoji = {
            "food": "🍽️",
            "sightseeing": "🏛️",
            "transport": "🚃",
            "shopping": "🛍️",
            "rest": "☕",
            "accommodation": "🏨",
        }

        rendered = self._render_itinerary(itinerary)
        lines = [
            "<current_itinerary>",
            f"Title: {rendered['title']}",
            f"Destination: {rendered['destination']}",
            f"Dates: {rendered['start_date']} to {rendered['end_date']}",
            "",
        ]

        all_cost_items: List[Dict[str, str]] = []

        for day_info in rendered["days"]:
            lines.append(f"Day {day_info['day']} ({day_info['date']}):")
            if not day_info["activities"]:
                lines.append("  (no activities planned)")
            else:
                for act in day_info["activities"]:
                    cat_tag = category_emoji.get(act.get("category", ""), "📌")
                    loc_part = f" @ {act['location']}" if act.get("location") else ""
                    dur_part = f" ({act['duration']})" if act.get("duration") else ""
                    cost_part = f" 💰{act['estimated_cost']}" if act.get("estimated_cost") else ""
                    rating_part = f" ★{act['rating']}" if act.get("rating") else ""
                    price_part = f" [{act['price_level']}]" if act.get("price_level") else ""
                    hours_part = f" 🕐{act['opening_hours']}" if act.get("opening_hours") else ""
                    notes_part = f" — {act['notes']}" if act.get("notes") else ""
                    url_part = f" [{act['url']}]" if act.get("url") else ""
                    maps_part = f" [map: {act['maps_url']}]" if act.get("maps_url") else ""
                    web_part = f" [web: {act['website']}]" if act.get("website") else ""
                    review_part = f" 💬{act['review_summary']}" if act.get("review_summary") else ""
                    lines.append(
                        f"  {cat_tag} [{act['id']}] {act['time']} {act['name']}"
                        f"{dur_part}{loc_part}{cost_part}{rating_part}{price_part}"
                        f"{hours_part}{notes_part}{review_part}{url_part}{maps_part}{web_part}"
                    )

            # Daily cost summary
            day_costs = day_info.get("cost_items", [])
            if day_costs:
                all_cost_items.extend(day_costs)
                lines.append(f"  --- Day {day_info['day']} costs ---")
                for ci in day_costs:
                    lines.append(f"    {ci['category']}: {ci['name']} = {ci['cost']}")
            lines.append("")

        # Trip budget summary
        if all_cost_items:
            lines.append("--- Trip Budget Summary ---")
            by_cat: Dict[str, List[str]] = {}
            for ci in all_cost_items:
                by_cat.setdefault(ci["category"], []).append(f"{ci['name']}={ci['cost']}")
            for cat, items in by_cat.items():
                emoji = category_emoji.get(cat, "📌")
                lines.append(f"  {emoji} {cat}: {', '.join(items)}")
            lines.append("")

        lines.append("</current_itinerary>")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Session cleanup
    # ------------------------------------------------------------------

    def clear_session(self, session_id: str) -> None:
        self._itineraries.pop(session_id, None)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_itinerary(itinerary: Itinerary) -> Dict[str, Any]:
        days_out = []
        map_places: List[Dict[str, Any]] = []
        for day_num in sorted(itinerary.days):
            day_plan = itinerary.days[day_num]
            activities = []
            cost_items: List[Dict[str, str]] = []
            for a in day_plan.activities:
                act: Dict[str, Any] = {
                    "id": a.id,
                    "time": a.time,
                    "name": a.name,
                    "location": a.location,
                    "notes": a.notes,
                }
                if a.duration:
                    act["duration"] = a.duration
                if a.url:
                    act["url"] = a.url
                if a.maps_url:
                    act["maps_url"] = a.maps_url
                if a.category:
                    act["category"] = a.category
                if a.estimated_cost:
                    act["estimated_cost"] = a.estimated_cost
                    cost_items.append({
                        "name": a.name,
                        "category": a.category or "other",
                        "cost": a.estimated_cost,
                    })
                if a.rating:
                    act["rating"] = a.rating
                if a.price_level:
                    act["price_level"] = a.price_level
                if a.opening_hours:
                    act["opening_hours"] = a.opening_hours
                if a.website:
                    act["website"] = a.website
                if a.review_summary:
                    act["review_summary"] = a.review_summary
                activities.append(act)

                # Collect map markers from activities with coordinates
                if a.lat and a.lon:
                    map_places.append({
                        "name": a.name,
                        "address": a.location,
                        "lat": a.lat,
                        "lon": a.lon,
                        "rating": a.rating if a.rating else None,
                        "maps_url": a.maps_url or None,
                        "website": a.website or None,
                        "price_level": a.price_level or None,
                        "opening_hours": [a.opening_hours] if a.opening_hours else None,
                        "editorial_summary": a.review_summary or None,
                    })
            day_data: Dict[str, Any] = {
                "day": day_num,
                "date": day_plan.date,
                "activities": activities,
            }
            if cost_items:
                day_data["cost_items"] = cost_items
            days_out.append(day_data)

        result: Dict[str, Any] = {
            "title": itinerary.title,
            "destination": itinerary.destination,
            "start_date": itinerary.start_date,
            "end_date": itinerary.end_date,
            "total_days": len(itinerary.days),
            "days": days_out,
        }
        if map_places:
            result["map_places"] = map_places
        return result
