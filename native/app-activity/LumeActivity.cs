// Foreground identity only. No window text, URLs, command lines or input hooks.
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

internal static class LumeActivity {
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint size; public uint tick; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint length, out uint needed);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static object Unavailable() { return new {estado="indisponivel"}; }
    private static object Sample() {
        IntPtr desktop=OpenInputDesktop(0,false,1); // DESKTOP_READOBJECTS, no input access.
        if(desktop==IntPtr.Zero) return Unavailable();
        try {
            var name=new StringBuilder(256); uint needed;
            if(!GetUserObjectInformation(desktop,2,name,512,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase))
                return new {estado="bloqueado"};
        } finally { CloseDesktop(desktop); }
        var input=new LastInput {size=(uint)Marshal.SizeOf(typeof(LastInput))};
        if(!GetLastInputInfo(ref input)) return Unavailable();
        uint idle=unchecked((uint)Environment.TickCount-input.tick);
        if(idle>=60000) return new {estado="inativo"};
        IntPtr window=GetForegroundWindow(); uint pid;
        if(window==IntPtr.Zero || GetWindowThreadProcessId(window,out pid)==0 || pid==0) return Unavailable();
        IntPtr process=OpenProcess(0x1000,false,pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if(process==IntPtr.Zero) return Unavailable();
        try {
            var path=new StringBuilder(32768); uint size=(uint)path.Capacity;
            if(!QueryFullProcessImageName(process,0,path,ref size) || GetForegroundWindow()!=window) return Unavailable();
            string id=Path.GetFileName(path.ToString()).ToLowerInvariant();
            // Full executable path never crosses the helper boundary.
            if(id.Length<5 || id.Length>128 || !id.EndsWith(".exe",StringComparison.Ordinal)) return Unavailable();
            return new {estado="amostra",appId=id,idleMs=idle};
        } finally { CloseHandle(process); }
    }
    public static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length!=1 || args[0]!="--sample") return 2;
        try { Console.WriteLine(new JavaScriptSerializer().Serialize(Sample())); return 0; }
        catch { Console.WriteLine("{\"estado\":\"indisponivel\"}"); return 0; }
    }
}
