import CapKit
import Charts
import Observation
import SwiftUI

enum AnalyticsScope: Hashable {
    case organization
    case cap(CapID, title: String)
}

@MainActor
@Observable
final class AnalyticsModel {
    enum State: Equatable {
        case loading
        case loaded(AnalyticsData)
        case proRequired
        case failed(CapAPIError)
    }

    struct Key: Hashable {
        let organizationId: String?
        let range: AnalyticsRange
        let spaceId: String?
    }

    let scope: AnalyticsScope
    var range: AnalyticsRange = .week
    var spaceId: String?
    var organizationId: String?
    private(set) var states: [Key: State] = [:]
    private(set) var refreshing: Set<Key> = []

    init(scope: AnalyticsScope) {
        self.scope = scope
    }

    var key: Key { Key(organizationId: organizationId, range: range, spaceId: spaceId) }
    var state: State { states[key] ?? .loading }

    private func cacheKey(_ key: Key) -> String? {
        guard case .organization = scope, let organizationId = key.organizationId else { return nil }
        return ["analytics", organizationId, key.spaceId ?? "all", key.range.rawValue].joined(separator: "-")
    }

    func load(session: SessionModel, force: Bool = false) async {
        let key = key
        guard key.organizationId != nil else { return }
        if !force, case .loaded = states[key], !refreshing.contains(key) { return }
        guard !refreshing.contains(key) else { return }
        refreshing.insert(key)
        defer { refreshing.remove(key) }

        if states[key] == nil, let cacheKey = cacheKey(key),
           let cached = await session.services.cache.read(AnalyticsData.self, namespace: session.credentials.userId, key: cacheKey) {
            states[key] = .loaded(cached)
        }

        do {
            let response: AnalyticsResponse
            switch scope {
            case .organization:
                response = try await session.api.organizationAnalytics(range: key.range, spaceId: key.spaceId)
            case let .cap(id, _):
                response = try await session.api.capAnalytics(id, range: key.range)
            }
            guard response.available, let data = response.data else {
                states[key] = .proRequired
                return
            }
            states[key] = .loaded(data)
            if let cacheKey = cacheKey(key) {
                let cache = session.services.cache
                let namespace = session.credentials.userId
                Task.detached(priority: .utility) {
                    await cache.write(data, namespace: namespace, key: cacheKey)
                }
            }
        } catch {
            guard error != .cancelled else { return }
            if case .loaded = states[key] {
                session.toasts.show(error)
            } else {
                states[key] = .failed(error)
            }
        }
    }
}

struct AnalyticsScreen: View {
    let scope: AnalyticsScope
    @Environment(SessionModel.self) private var session
    @State private var model: AnalyticsModel

    init(scope: AnalyticsScope) {
        self.scope = scope
        _model = State(initialValue: AnalyticsModel(scope: scope))
    }

    private var title: String {
        switch scope {
        case .organization: "Analytics"
        case .cap: "Cap analytics"
        }
    }

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if case let .cap(_, capTitle) = scope {
                    Text(capTitle)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Picker("Range", selection: $model.range) {
                    ForEach(AnalyticsRange.allCases) { range in
                        Text(range.title)
                            .accessibilityLabel(range.accessibilityTitle)
                            .tag(range)
                    }
                }
                .pickerStyle(.segmented)

                switch model.state {
                case .loading:
                    AnalyticsSkeleton()
                case .proRequired:
                    ContentUnavailableView(
                        "Analytics is a Cap Pro feature",
                        systemImage: "chart.bar.xaxis",
                        description: Text("See who watched, where they watched from and how your Caps perform over time with Cap Pro.")
                    )
                    .padding(.top, 40)
                case let .failed(error):
                    ContentUnavailableView {
                        Label("Analytics unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error.errorDescription ?? "")
                    } actions: {
                        Button("Try again") { Task { await model.load(session: session, force: true) } }
                            .buttonStyle(.glassProminent)
                    }
                    .padding(.top, 40)
                case let .loaded(data):
                    AnalyticsContent(data: data, range: model.range, showsCaps: scope == .organization)
                        .opacity(model.refreshing.contains(model.key) ? 0.7 : 1)
                        .animation(.easeOut(duration: 0.2), value: model.refreshing.contains(model.key))
                }
            }
            .padding(.horizontal, CapTheme.spacing)
            .padding(.bottom, 24)
            .animation(.snappy(duration: 0.3), value: model.key)
        }
        .navigationTitle(title)
        .toolbarTitleDisplayMode(scope == .organization ? .inlineLarge : .inline)
        .toolbar {
            if scope == .organization, !session.spaces.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("Filter", selection: $model.spaceId) {
                            Text("Whole organization").tag(String?.none)
                            ForEach(session.spaces.filter { $0.kind == .space }) { space in
                                Text(space.name).tag(Optional(space.id))
                            }
                        }
                    } label: {
                        Label("Filter", systemImage: model.spaceId == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                    }
                }
            }
        }
        .refreshable { await model.load(session: session, force: true) }
        .task(id: model.key) { await model.load(session: session) }
        .onChange(of: session.organizationId, initial: true) { previous, current in
            if previous != current { model.spaceId = nil }
            model.organizationId = current
        }
    }
}

private struct AnalyticsContent: View {
    let data: AnalyticsData
    let range: AnalyticsRange
    let showsCaps: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var wide: Bool {
        horizontalSizeClass == .regular && verticalSizeClass == .regular
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: wide ? (showsCaps ? 4 : 3) : (showsCaps ? 2 : 3))
            LazyVGrid(columns: columns, spacing: 12) {
                MetricTile(title: "Views", value: data.counts.views, systemImage: "eye.fill", tint: .blue)
                MetricTile(title: "Comments", value: data.counts.comments, systemImage: "bubble.left.fill", tint: .green)
                MetricTile(title: "Reactions", value: data.counts.reactions, systemImage: "face.smiling.inverse", tint: .orange)
                if showsCaps {
                    MetricTile(title: "Caps", value: data.counts.caps, systemImage: "play.rectangle.fill", tint: .purple)
                }
            }

            TrendCard(points: data.chart, range: range)

            if wide {
                HStack(alignment: .top, spacing: 12) {
                    locations
                    technology
                }
            } else {
                locations
                technology
            }

            if showsCaps, !data.breakdowns.topCaps.isEmpty {
                TopCapsCard(caps: data.breakdowns.topCaps)
            }
        }
    }

    private var locations: some View {
        BreakdownCard(
            title: "Locations",
            tabs: [("Countries", data.breakdowns.countries, true), ("Cities", data.breakdowns.cities, false)]
        )
    }

    private var technology: some View {
        BreakdownCard(
            title: "Technology",
            tabs: [("Browsers", data.breakdowns.browsers, false), ("OS", data.breakdowns.operatingSystems, false), ("Devices", data.breakdowns.devices, false)]
        )
    }
}

private struct MetricTile: View {
    let title: String
    let value: Int
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(value, format: .number)
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(value)))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .capCardBackground()
        .accessibilityElement(children: .combine)
    }
}

private struct TrendCard: View {
    enum Metric: String, CaseIterable, Identifiable {
        case views = "Views"
        case comments = "Comments"
        case reactions = "Reactions"

        var id: String { rawValue }

        func value(_ point: AnalyticsPoint) -> Int {
            switch self {
            case .views: point.views
            case .comments: point.comments
            case .reactions: point.reactions
            }
        }
    }

    let points: [AnalyticsPoint]
    let range: AnalyticsRange
    @State private var metric: Metric = .views
    @State private var selection: Date?

    private var dated: [(date: Date, value: Int)] {
        points.compactMap { point in point.date.map { ($0, metric.value(point)) } }
    }

    private var selected: (date: Date, value: Int)? {
        guard let selection else { return nil }
        return dated.min { abs($0.date.timeIntervalSince(selection)) < abs($1.date.timeIntervalSince(selection)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(metric.rawValue)
                        .font(.headline)
                    if let selected {
                        Text("\(selected.value.formatted()) on \(selected.date.formatted(range.usesHourlyBuckets ? .dateTime.hour().minute() : .dateTime.month().day()))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    } else {
                        Text("Over time")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Picker("Metric", selection: $metric) {
                    ForEach(Metric.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.menu)
            }

            if dated.isEmpty {
                Text("No activity in this period.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                Chart {
                    ForEach(dated, id: \.date) { point in
                        AreaMark(x: .value("Date", point.date), y: .value(metric.rawValue, point.value))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [Color.accentColor.opacity(0.35), Color.accentColor.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("Date", point.date), y: .value(metric.rawValue, point.value))
                            .interpolationMethod(.monotone)
                            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .foregroundStyle(Color.accentColor)
                    }
                    if let selected {
                        RuleMark(x: .value("Selected", selected.date))
                            .foregroundStyle(.secondary.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        PointMark(x: .value("Date", selected.date), y: .value(metric.rawValue, selected.value))
                            .symbolSize(70)
                            .foregroundStyle(Color.accentColor)
                    }
                }
                .chartXSelection(value: $selection)
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                        AxisValueLabel()
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                        AxisValueLabel(format: range.usesHourlyBuckets ? .dateTime.hour() : .dateTime.month(.abbreviated).day())
                    }
                }
                .frame(height: 200)
                .animation(.snappy(duration: 0.3), value: metric)
                .sensoryFeedback(.selection, trigger: selected?.date)
                .accessibilityLabel("\(metric.rawValue) over time")
            }
        }
        .padding(16)
        .capCardBackground()
    }
}

private struct BreakdownCard: View {
    let title: String
    let tabs: [(String, [AnalyticsBreakdown], Bool)]
    @State private var selected = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(title).font(.headline)
                Spacer()
            }
            Picker(title, selection: $selected) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                    Text(tab.0).tag(index)
                }
            }
            .pickerStyle(.segmented)

            let (_, rows, isCountry) = tabs[min(selected, tabs.count - 1)]
            if rows.isEmpty {
                Text("No data yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 8) {
                    ForEach(rows.prefix(8)) { row in
                        BreakdownRow(row: row, isCountry: isCountry, maxViews: rows.map(\.views).max() ?? 1)
                    }
                }
            }
        }
        .padding(16)
        .capCardBackground()
        .animation(.snappy(duration: 0.25), value: selected)
    }
}

private struct BreakdownRow: View {
    let row: AnalyticsBreakdown
    let isCountry: Bool
    let maxViews: Int

    private var label: String {
        if isCountry { return CapFormat.regionName(forCode: row.name) }
        if let subtitle = row.subtitle, subtitle.count == 2 {
            return "\(row.name), \(CapFormat.regionName(forCode: subtitle))"
        }
        return row.name.isEmpty ? "Unknown" : row.name
    }

    private var flag: String? {
        if isCountry { return CapFormat.flag(forRegionCode: row.name) }
        return row.subtitle.flatMap { CapFormat.flag(forRegionCode: $0) }
    }

    var body: some View {
        HStack(spacing: 10) {
            if let flag { Text(flag) }
            Text(label)
                .font(.subheadline)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(row.views, format: .number)
                .font(.subheadline.weight(.semibold).monospacedDigit())
            Text(CapFormat.percentage(row.percentage))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(alignment: .leading) {
            GeometryReader { proxy in
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .frame(width: max(8, proxy.size.width * CGFloat(row.views) / CGFloat(max(1, maxViews))))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct TopCapsCard: View {
    let caps: [AnalyticsBreakdown]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Top Caps").font(.headline)
            ForEach(Array(caps.prefix(10).enumerated()), id: \.element.id) { index, cap in
                if let capId = cap.capId.flatMap(CapID.init) {
                    NavigationLink(value: Route.cap(capId)) {
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            Text(cap.name.isEmpty ? "Untitled" : cap.name)
                                .font(.subheadline)
                                .lineLimit(1)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            StatLabel(value: cap.views, systemImage: "eye", accessibilityNoun: "views")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 8)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(16)
        .capCardBackground()
    }
}

private struct AnalyticsSkeleton: View {
    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: CapTheme.cardRadius).fill(.quaternary).frame(height: 110)
                RoundedRectangle(cornerRadius: CapTheme.cardRadius).fill(.quaternary).frame(height: 110)
            }
            RoundedRectangle(cornerRadius: CapTheme.cardRadius).fill(.quaternary).frame(height: 260)
            RoundedRectangle(cornerRadius: CapTheme.cardRadius).fill(.quaternary).frame(height: 200)
        }
        .shimmering()
        .accessibilityLabel("Loading analytics")
    }
}
