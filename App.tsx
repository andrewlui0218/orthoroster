import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Download, RotateCcw, Users, CheckCircle2, Upload, Loader2, Menu, X } from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";
import { INITIAL_STAFF, APPT_STAFF_IDS, SESSIONS } from './constants';
import { StaffMember, RosterState, DragItem } from './types';
import { Magnet } from './components/Magnet';
import { RosterBoard } from './components/RosterBoard';
import { exportRosterAsImage } from './services/imageExporter';

export default function App() {
  const exportRef = useRef<HTMLDivElement>(null);
  
  // State
  const [roster, setRoster] = useState<RosterState>({});
  const [activeTab, setActiveTab] = useState<'PT' | 'Support'>('PT');
  const [staffList] = useState<StaffMember[]>(INITIAL_STAFF);
  
  // Selection state for "Stamp" mode
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const selectedStaffMember = useMemo(() => 
    staffList.find(s => s.id === selectedStaffId), 
  [selectedStaffId, staffList]);

  // Auto-Draft State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper to get staff by role (allows multiple assignments)
  const getStaffByRole = useCallback((role: 'PT' | 'Support') => {
    return staffList.filter(s => s.role === role);
  }, [staffList]);

  // Calculate FTE for Physio staff
  // 1 assignment = 0.25 FTE
  const physioFTE = useMemo(() => {
    let count = 0;
    Object.values(roster).forEach(staffIds => {
      staffIds.forEach(id => {
        const staff = staffList.find(s => s.id === id);
        // Only count PT assignments towards Physio Manpower FTE
        if (staff?.role === 'PT') {
          count++;
        }
      });
    });
    return count * 0.25;
  }, [roster, staffList]);

  // Validation Logic
  const isValidPlacement = (staff: StaffMember, columnId: string): { valid: boolean; error?: string } => {
    const isPcaColumn = columnId === 'PCA' || columnId.endsWith('PCA');
    
    if (staff.role === 'PT' && isPcaColumn) {
      return { valid: false, error: "Physiotherapists (PT) cannot be placed in the PCA column." };
    }
    if (staff.role === 'Support' && !isPcaColumn) {
      return { valid: false, error: "Support staff (PCA) cannot be placed in PT columns." };
    }
    return { valid: true };
  };

  // --- Gemini Auto-Draft Handler ---
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsAnalyzing(true);
    try {
      // 1. Convert to Base64
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // 2. Call Gemini API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
             { inlineData: { mimeType: file.type, data: base64Data } },
             { text: `
               Analyze this roster image. 
               Identify staff members who have duties labeled as 'Orth', 'Ortho', or are highlighted in green in columns 1, 2, 3, or 4.
               Return a JSON object containing a list of these staff members and the specific session numbers (1, 2, 3, 4) they are assigned to.
               Ignore any staff who do not have 'Orth' duties.
             ` }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              assignments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    sessions: { 
                      type: Type.ARRAY, 
                      items: { type: Type.INTEGER } 
                    }
                  }
                }
              }
            }
          }
        }
      });

      // 3. Process Response
      const result = JSON.parse(response.text);
      if (!result.assignments || !Array.isArray(result.assignments)) {
         throw new Error("Invalid response format");
      }

      // 4. Logic for distributing teams
      const apptStaffAssignments: { staff: StaffMember; sessions: number[] }[] = [];
      const rptStaffAssignments: { staff: StaffMember; sessions: number[] }[] = [];

      // Categorize extracted staff
      result.assignments.forEach((assignment: any) => {
        const staff = staffList.find(s => s.name.toLowerCase() === assignment.name.trim().toLowerCase());
        if (staff && staff.role === 'PT') {
           if (APPT_STAFF_IDS.includes(staff.id)) {
             apptStaffAssignments.push({ staff, sessions: assignment.sessions });
           } else {
             rptStaffAssignments.push({ staff, sessions: assignment.sessions });
           }
        }
      });

      // Distribute APPT staff
      const team1Appts: typeof apptStaffAssignments = [];
      const team2Appts: typeof apptStaffAssignments = [];
      let nextApptTeam = Math.random() < 0.5 ? 1 : 2; 

      apptStaffAssignments.forEach(item => {
        if (team1Appts.length < team2Appts.length) {
          team1Appts.push(item);
        } else if (team2Appts.length < team1Appts.length) {
           team2Appts.push(item);
        } else {
           if (nextApptTeam === 1) {
             team1Appts.push(item);
             nextApptTeam = 2;
           } else {
             team2Appts.push(item);
             nextApptTeam = 1;
           }
        }
      });

      // Distribute RPT staff
      const team1Rpts: typeof rptStaffAssignments = [];
      const team2Rpts: typeof rptStaffAssignments = [];
      const team1HasAppt = team1Appts.length > 0;
      const team2HasAppt = team2Appts.length > 0;
      let nextRptTeam = Math.random() < 0.5 ? 1 : 2;

      rptStaffAssignments.forEach(item => {
        const canJoinTeam1 = team1HasAppt;
        const canJoinTeam2 = team2HasAppt;

        if (canJoinTeam1 && !canJoinTeam2) {
           team1Rpts.push(item);
        } else if (!canJoinTeam1 && canJoinTeam2) {
           team2Rpts.push(item);
        } else if (canJoinTeam1 && canJoinTeam2) {
           if (team1Rpts.length < team2Rpts.length) {
             team1Rpts.push(item);
           } else if (team2Rpts.length < team1Rpts.length) {
             team2Rpts.push(item);
           } else {
             if (nextRptTeam === 1) {
                team1Rpts.push(item);
                nextRptTeam = 2;
             } else {
                team2Rpts.push(item);
                nextRptTeam = 1;
             }
           }
        } else {
           if (team1Rpts.length <= team2Rpts.length) {
             team1Rpts.push(item);
           } else {
             team2Rpts.push(item);
           }
        }
      });

      // 5. Build Roster State
      const newRoster = { ...roster };
      const sessionMap: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
      let addedCount = 0;

      const addToRoster = (items: typeof apptStaffAssignments, columnId: string) => {
         items.forEach(({ staff, sessions }) => {
            sessions.forEach(sessNum => {
               const sessionKey = sessionMap[sessNum];
               if (sessionKey) {
                 const cellId = `${sessionKey}-${columnId}`;
                 const current = newRoster[cellId] || [];
                 if (!current.includes(staff.id)) {
                   newRoster[cellId] = [...current, staff.id];
                   addedCount++;
                 }
               }
            });
         });
      };

      addToRoster(team1Appts, 'T1_PTI');
      addToRoster(team2Appts, 'T2_PTI');
      addToRoster(team1Rpts, 'T1_PTII');
      addToRoster(team2Rpts, 'T2_PTII');
      
      setRoster(newRoster);
      alert(`Draft generated! Added ${addedCount} assignments.`);

    } catch (error) {
      console.error("Error generating roster:", error);
      alert("Failed to analyze image. Please try again or use a clearer image.");
    } finally {
      setIsAnalyzing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // --- Drag / Click Handlers ---

  const handleDragStart = (e: React.DragEvent, id: string, source: 'pool' | 'grid', sourceCellId?: string) => {
    const item: DragItem = { id, source, sourceCellId };
    e.dataTransfer.setData('application/json', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
    if (selectedStaffId) setSelectedStaffId(null);
  };

  const handleDropOnCell = (e: React.DragEvent, targetCellId: string) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/json');
    if (!data) return;

    const item: DragItem = JSON.parse(data);
    const staff = staffList.find(s => s.id === item.id);
    if (!staff) return;

    const columnId = targetCellId.split('-').slice(1).join('-');
    const validation = isValidPlacement(staff, columnId);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    setRoster(prev => {
      const newRoster = { ...prev };
      if (item.source === 'grid' && item.sourceCellId) {
        newRoster[item.sourceCellId] = (newRoster[item.sourceCellId] || []).filter(id => id !== item.id);
      }
      const currentCell = newRoster[targetCellId] || [];
      if (!currentCell.includes(item.id)) {
        newRoster[targetCellId] = [...currentCell, item.id];
      }
      return newRoster;
    });
  };

  const handleDropOnPool = (e: React.DragEvent) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/json');
    if (!data) return;
    const item: DragItem = JSON.parse(data);

    if (item.source === 'grid' && item.sourceCellId) {
      setRoster(prev => {
        const newRoster = { ...prev };
        newRoster[item.sourceCellId] = (newRoster[item.sourceCellId] || []).filter(id => id !== item.id);
        return newRoster;
      });
    }
  };

  const handleStaffClick = (id: string) => {
    setSelectedStaffId(prev => prev === id ? null : id);
  };

  const handleGridCellClick = (cellId: string) => {
    if (!selectedStaffId) return;

    const staff = staffList.find(s => s.id === selectedStaffId);
    if (!staff) return;

    const columnId = cellId.split('-').slice(1).join('-');
    const validation = isValidPlacement(staff, columnId);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    setRoster(prev => {
      const currentCell = prev[cellId] || [];
      if (currentCell.includes(selectedStaffId)) {
        return {
          ...prev,
          [cellId]: currentCell.filter(id => id !== selectedStaffId)
        };
      } else {
        return {
          ...prev,
          [cellId]: [...currentCell, selectedStaffId]
        };
      }
    });
  };

  const handleColumnHeaderClick = (colId: string) => {
    if (!selectedStaffId) return;

    const staff = staffList.find(s => s.id === selectedStaffId);
    if (!staff) return;

    const validation = isValidPlacement(staff, colId);
    if (!validation.valid) {
      alert(validation.error);
      return;
    }

    setRoster(prev => {
      const newRoster = { ...prev };
      SESSIONS.forEach(session => {
        const cellId = `${session}-${colId}`;
        const currentCell = newRoster[cellId] || [];
        if (!currentCell.includes(selectedStaffId)) {
          newRoster[cellId] = [...currentCell, selectedStaffId];
        }
      });
      return newRoster;
    });
  };

  const handleExport = () => {
    setSelectedStaffId(null);
    // Export the HIDDEN desktop board, not the visible one
    setTimeout(() => {
        if (exportRef.current) {
            exportRosterAsImage(exportRef.current, `roster-${new Date().toISOString().split('T')[0]}.jpg`);
        }
    }, 50);
  };

  const handleReset = () => {
    // Explicit window.confirm for better browser compatibility
    if (window.confirm('Are you sure you want to clear the entire roster?')) {
      setRoster({});
      setSelectedStaffId(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="h-screen bg-gray-50 flex flex-col md:flex-row font-sans text-gray-900 overflow-hidden">
      
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
      />

      {/* --- HIDDEN EXPORT BOARD --- */}
      {/* This board is always rendered as 1280px wide Desktop layout, used solely for generating the JPG */}
      <div 
        style={{ position: 'absolute', top: -9999, left: -9999, width: '1280px', height: '800px', zIndex: -10 }}
      >
        <RosterBoard 
          ref={exportRef}
          roster={roster}
          staffList={staffList}
          physioFTE={physioFTE}
          selectedStaffId={null} // Don't show selection on export
          forceDesktop={true} // FORCE desktop styling
        />
      </div>

      {/* --- DESKTOP SIDEBAR --- */}
      <div 
        className="hidden md:flex w-80 bg-white border-r border-gray-200 flex-col shadow-xl z-20 shrink-0 h-full"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDropOnPool}
      >
        <div className="p-4">
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2 mb-1">
            <Users className="w-6 h-6" /> Staff
          </h1>
          <p className="text-sm text-gray-500 mb-3">Drag or click to assign.</p>
          
          <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg">
            {(['PT', 'Support'] as const).map(role => (
              <button
                key={role}
                onClick={() => { setActiveTab(role); setSelectedStaffId(null); }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                  activeTab === role ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {role === 'PT' ? 'Physio' : 'Support'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-2 grid grid-cols-2 gap-2 content-start">
          {getStaffByRole(activeTab).map(staff => (
            <Magnet 
              key={staff.id}
              staff={staff} 
              onDragStart={(e, id) => handleDragStart(e, id, 'pool')} 
              onClick={() => handleStaffClick(staff.id)}
              isSelected={selectedStaffId === staff.id}
            />
          ))}
        </div>

        <div className="p-4 bg-white border-t border-gray-200 flex flex-col gap-2">
          <button 
            onClick={() => fileInputRef.current?.click()}
            disabled={isAnalyzing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {isAnalyzing ? <Loader2 className="animate-spin w-4 h-4" /> : <Upload className="w-4 h-4" />} 
            Draft from Image
          </button>
          <div className="flex gap-2">
            <button 
              type="button" 
              onClick={handleReset} 
              className="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" /> Reset
            </button>
            <button 
              type="button"
              onClick={handleExport} 
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" /> Export
            </button>
          </div>
        </div>
      </div>

      {/* --- MAIN AREA: ROSTER BOARD --- */}
      <div className="flex-1 bg-gray-100 relative flex flex-col h-full overflow-hidden">
        
        {/* Floating Selection Indicator (Mobile & Desktop) */}
        {selectedStaffMember && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-30 pointer-events-none">
            <div className="bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 animate-bounce-short">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-bold">Placing: {selectedStaffMember.name}</span>
            </div>
          </div>
        )}

        {/* Scrollable Board Container */}
        <div className="flex-1 overflow-hidden p-1 md:p-8 flex flex-col">
           {/* The Visible Interactive Whiteboard */}
           <RosterBoard 
             roster={roster}
             staffList={staffList}
             physioFTE={physioFTE}
             selectedStaffId={selectedStaffId}
             onColumnClick={handleColumnHeaderClick}
             onCellClick={handleGridCellClick}
             onDropOnCell={handleDropOnCell}
             onDragStart={handleDragStart}
             forceDesktop={false} // Use responsive sizing
           />
        </div>

        {/* --- MOBILE BOTTOM CONTROLS --- */}
        <div className="md:hidden bg-white border-t border-gray-300 flex flex-col shadow-[0_-4px_10px_rgba(0,0,0,0.1)] z-20 shrink-0">
          
          {/* Action Bar */}
          <div className="flex items-center justify-between p-2 border-b border-gray-100 bg-gray-50">
             <div className="flex gap-2">
                <button onClick={() => fileInputRef.current?.click()} className="p-2 bg-emerald-600 text-white rounded shadow-sm">
                   {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                </button>
                <button 
                  type="button" 
                  onClick={handleReset} 
                  className="p-2 bg-red-100 text-red-600 rounded"
                >
                   <RotateCcw className="w-4 h-4" />
                </button>
                <button 
                  type="button" 
                  onClick={handleExport} 
                  className="p-2 bg-blue-100 text-blue-600 rounded"
                >
                   <Download className="w-4 h-4" />
                </button>
             </div>
             
             {/* Role Toggles */}
             <div className="flex bg-gray-200 rounded p-0.5">
               {(['PT', 'Support'] as const).map(role => (
                 <button
                   key={role}
                   onClick={() => { setActiveTab(role); setSelectedStaffId(null); }}
                   className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${
                     activeTab === role ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500'
                   }`}
                 >
                   {role === 'PT' ? 'PT' : 'PCA'}
                 </button>
               ))}
             </div>
          </div>

          {/* Horizontal Staff List */}
          <div className="overflow-x-auto whitespace-nowrap p-2 bg-white min-h-[60px] flex items-center gap-2">
             {getStaffByRole(activeTab).map(staff => (
               <div key={staff.id} className="inline-block shrink-0">
                  <div 
                    onClick={() => handleStaffClick(staff.id)}
                    className={`
                      px-2 py-1.5 rounded border border-gray-300 shadow-sm cursor-pointer font-handwriting text-xs font-bold
                      transition-all transform active:scale-95
                      ${staff.defaultColor === 'yellow' ? 'bg-yellow-300' : 'bg-white'}
                      ${selectedStaffId === staff.id ? 'ring-2 ring-blue-500 scale-105 z-10' : ''}
                    `}
                  >
                    {staff.name}
                  </div>
               </div>
             ))}
             {/* Spacer for scroll end */}
             <div className="w-4"></div>
          </div>
        </div>
      </div>
    </div>
  );
}