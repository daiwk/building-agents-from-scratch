"""Python 命令行入口：python -m from_scratch_agent.cli。"""

from .runtime import create_agent_from_env, load_local_env


def main() -> None:
    load_local_env()
    agent = create_agent_from_env()

    print("Python Agent · 输入 /reset 清空记忆，/exit 退出")
    while True:
        user_input = input("you> ").strip()
        if user_input == "/exit":
            break
        if user_input == "/reset":
            agent.reset()
            print("memory cleared")
            continue
        if not user_input:
            continue

        for event in agent.run(user_input):
            if event["type"] == "tool_start":
                print("  tool>", event["call"]["name"], event["call"]["arguments"])
            elif event["type"] == "tool_end":
                print("  result>", event["result"]["content"])
            elif event["type"] == "text":
                print("agent>", event["text"])
            elif event["type"] == "usage":
                totals = event["totals"]
                cost = ""
                if "estimated_cost" in totals:
                    cost = (
                        f" · estimated {totals['currency']} "
                        f"{totals['estimated_cost']:.6f}"
                    )
                print(f"  usage> {totals['total_tokens']} tokens{cost}")
            elif event["type"] == "rate_limit_wait":
                print(
                    "  rate limit> waiting "
                    f"{event['delay_seconds']:.1f}s"
                )


if __name__ == "__main__":
    main()
