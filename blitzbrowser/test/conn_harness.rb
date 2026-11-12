# Local threaded repro + cid-tracing harness for the dead-browser issue.
# Each attempt opens a Ferrum CDP connection to BlitzBrowser carrying a unique
# cid=<id> query param. The fork logs that cid at the earliest server point and at
# each gateway milestone, so a dead client cid can be matched to how far it got
# server-side (never arrived / parsed / waited / got instance / ready). Bounded by a
# hard per-attempt Timeout so a hung Ferrum.new can't block a thread forever.
#
# Run (ferrum from the app bundle):
#   cd web-app && mise exec -- bundle exec ruby <path>/conn_harness.rb
# Env: SCRAPER_HOST (default localhost), LEVELS ("2,4,6,8,12"), ROUNDS (3),
#   PROXY_URL (optional full http://user:pass@host:port), TIMEOUT (15), CAP (30),
#   THINK (0 = close immediately), LOG (optional file to append "cid outcome secs").
require "ferrum"
require "cgi"
require "timeout"
require "securerandom"

HOST    = ENV.fetch("SCRAPER_HOST", "localhost")
BASE    = "ws://#{HOST}:9999"
PROXY   = ENV["PROXY_URL"]
TIMEOUT = (ENV["TIMEOUT"] || "15").to_i
CAP     = (ENV["CAP"] || "30").to_i
THINK   = (ENV["THINK"] || "0").to_f
LEVELS  = (ENV["LEVELS"] || "2,4,6,8,12").split(",").map(&:to_i)
ROUNDS  = (ENV["ROUNDS"] || "3").to_i
LOG     = ENV["LOG"]
LOG_MUTEX = Mutex.new

def ws_url(cid)
  q = "cid=#{cid}"
  q += "&proxyUrl=#{CGI.escape(PROXY)}" if PROXY
  "#{BASE}/?#{q}"
end

def one_attempt
  cid = SecureRandom.hex(6)
  t0 = Time.now
  res = { cid: cid, ok: false, cat: nil, msg: nil }
  begin
    Timeout.timeout(CAP) do
      b = Ferrum::Browser.new(ws_url: ws_url(cid), timeout: TIMEOUT, process_timeout: TIMEOUT + 10)
      begin
        b.evaluate("1+1")
        sleep THINK if THINK > 0
        res[:ok] = true
      ensure
        b.close rescue nil
        b.quit rescue nil
      end
    end
  rescue Timeout::Error
    res[:cat] = :hang
  rescue => e
    m = e.message.to_s
    res[:cat] = if m.include?("Browser is dead") then :dead
                elsif m.include?("No browser instance") then :no_instance
                else :other end
    res[:msg] = "#{e.class}: #{m[0, 90]}"
  end
  res[:secs] = (Time.now - t0).round(2)
  res
end

puts "ws=#{ws_url('CID').sub(%r{://[^@/]*@}, '://***@')}  timeout=#{TIMEOUT} cap=#{CAP} think=#{THINK} rounds=#{ROUNDS}"
puts "-" * 72
$stdout.flush
LEVELS.each do |n|
  tally = Hash.new(0)
  times = []
  samples = []
  ROUNDS.times do
    threads = Array.new(n) { Thread.new { one_attempt } }
    threads.each do |t|
      r = t.value
      times << r[:secs]
      tally[r[:ok] ? :ok : r[:cat]] += 1
      samples << r[:msg] if r[:msg] && samples.size < 2
      if LOG
        LOG_MUTEX.synchronize { File.open(LOG, "a") { |f| f.puts("#{r[:cid]} #{r[:ok] ? :ok : r[:cat]} #{r[:secs]}") } }
      end
    end
  end
  total = n * ROUNDS
  st = times.sort
  fail_pct = total.zero? ? 0 : (100 * (total - tally[:ok]) / total)
  puts "concurrency=#{n.to_s.rjust(2)} total=#{total}  #{tally.map { |k, v| "#{k}=#{v}" }.join('  ')}  fail%=#{fail_pct}  secs med=#{st[st.size / 2]} max=#{st.last}"
  samples.each { |m| puts "    e.g. #{m}" }
  $stdout.flush
end
puts "done"
